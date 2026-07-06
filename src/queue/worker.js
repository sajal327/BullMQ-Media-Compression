import { Worker } from "bullmq";
import { redis, redisQueueConfig } from "../config/redis.js";
import { processMedia } from "../services/media.service.js";
import { markCompleted, markFailed } from "../services/post.service.js";
import { logger } from "../utils/logger.js";
import { Post } from "../models/post.model.js";
import { Revolution } from "../models/revolution.model.js";
import { User } from "../models/user.model.js";
import kycDocument from "../models/kycDocument.js";
import { invalidatePublicFeedCache } from "../utils/feedCache.js";

const QUEUE_NAME = "media-processing";

if (!global.__mediaWorker) global.__mediaWorker = null;

/* ------------------ HELPERS ------------------ */

const publishProgress = async (key, progress) => {
  try {
    if (redis?.status !== "ready") return;
    await redis.set(`progress:${key}`, progress, "EX", 600);
  } catch (err) {
    logger.warn({
      err,
      event: "progress_error",
    });
  }
};

const withTimeout = (promise, ms = 840000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Processing timeout")), ms),
    ),
  ]);

const normalizeKey = (url) => {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("key") || url;
  } catch {
    return url;
  }
};

/* ------------------ CACHE BUST ------------------ */

const bustAndRecache = async (postId, ownerId) => {
  if (redis?.status !== "ready") return;

  try {
    const populated = await Post.findById(postId)
      .populate({
        path: "user",
        strictPopulate: false,
        match: { isActive: true, isDeleted: false },
        select:
          "_id fullName profilePic isBatch adhaarVerified isActive isDeleted isProfileLocked role statePrivate districtPrivate primeLevel",
      })
      .lean();

    if (!populated || !populated.user) {
      await redis.del(`v1:post:${postId}`);
      await redis.del(`post:${postId}`);
      await redis.del(`post:${postId}:creator:${ownerId}`);
      return;
    }

    const score = new Date(populated.createdAt).getTime();
    const postIdStr = postId.toString();
    const ownerIdStr =
      typeof ownerId === "object"
        ? ownerId._id?.toString()
        : ownerId?.toString();

    const cacheObj = {
      ...populated,
      likes: [],
      saves: [],
    };

    const pipeline = redis.pipeline();

    pipeline.del(`v1:post:${postIdStr}`);
    pipeline.del(`post:${postIdStr}`);
    pipeline.del(`post:${postIdStr}:creator:${ownerIdStr}`);
    pipeline.set(`v1:post:${postIdStr}`, JSON.stringify(cacheObj), "EX", 300);
    pipeline.zadd(`feed:user:${ownerIdStr}`, score, postIdStr);

    if (populated.feedType === "PUBLIC") {
      pipeline.zadd("feed:public", score, postIdStr);
    }
    if (populated.feedType === "PRIME") {
      pipeline.zadd("v1:feed:prime", score, postIdStr);
    }

    await pipeline.exec();
    await invalidatePublicFeedCache();

    const sharedKeyPatterns = [
      "primefeed:v1:shared:ALL:*",
      "primefeed:v1:shared:NATIONAL:*",
    ];

    for (const pattern of sharedKeyPatterns) {
      try {
        const keys = await redis.keys(pattern);
        if (keys.length) await redis.del(...keys);
      } catch (err) {
        logger.warn(`Failed to bust shared cache: ${err.message}`);
      }
    }

    logger.info({
      event: "cache_busted",
      postId,
      ownerId,
    });
  } catch (err) {
    logger.error({
      err,
      event: "cache_rebuild_failed",
      postId,
      ownerId,
    });

    try {
      await redis.del(`v1:post:${postId}`);
      await redis.del(`post:${postId}`);
      await redis.del(`post:${postId}:creator:${ownerId}`);
    } catch {}
  }
};

/* ------------------ WORKER ------------------ */

export const startWorker = () => {
  if (global.__mediaWorker) {
    logger.warn({
      event: "worker_already_running",
    });
    return;
  }

  global.__mediaWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { name, data } = job;
      // job_started removed – use active event instead
      const jobStart = Date.now(); // for duration tracking

      try {
        /* ================================================
           media-processing
        ================================================ */
        if (name === "media-processing") {
          const { postId, images, video, version } = data;

          logger.info({
            event: "media_processing_received",
            jobId: job.id,
            postId,
            imageCount: images?.length ?? 0,
            hasVideo: !!video,
            version,
          });

          const post = await Post.findById(postId).lean();

          if (!post) {
            logger.warn({
              event: "post_deleted",
              postId,
              jobId: job.id,
            });
            return;
          }

          if (version && post.mediaVersion && version < post.mediaVersion) {
            logger.info({
              event: "stale_job_skipped",
              jobId: job.id,
              postId,
              version,
              currentVersion: post.mediaVersion,
            });
            return;
          }

          await publishProgress(postId, 10);

          let last = 10;

          const result = await withTimeout(
            processMedia({
              images,
              video,
              onProgress: async (p) => {
                if (p >= last + 10 || p === 100) {
                  last = p;
                  await publishProgress(postId, p);
                }
              },

              onEarlyImageThumbnails: async (thumbKeys) => {
                logger.info({
                  event: "early_image_thumbnails",
                  postId,
                  thumbKeys,
                });
                await Post.updateOne(
                  { _id: postId },
                  { $set: { imageThumbnails: thumbKeys } },
                );
                if (redis?.status === "ready") {
                  // Use pipeline for two DELs
                  await redis
                    .pipeline()
                    .del(`v1:post:${postId}`)
                    .del(`post:${postId}`)
                    .exec();
                }
              },

              onEarlyVideoThumbnail: async (thumbKey) => {
                logger.info({
                  event: "early_video_thumbnail",
                  postId,
                  thumbKey,
                });
                await Post.updateOne(
                  { _id: postId },
                  { $set: { videoThumbnail: thumbKey } },
                );
                if (redis?.status === "ready") {
                  const pipeline = redis.pipeline();
                  pipeline.del(`v1:post:${postId}`);
                  pipeline.del(`post:${postId}`);
                  const ownerId =
                    post.user?._id?.toString() ?? post.user?.toString();
                  if (ownerId) {
                    pipeline.del(`post:${postId}:creator:${ownerId}`);
                  }
                  await pipeline.exec();
                }
              },
            }),
          );

          logger.info({
            event: "process_media_completed",
            postId,
            imageCount: result.uploadedImages?.length ?? 0,
            thumbnailCount: result.uploadedImageThumbnails?.length ?? 0,
            hasVideo: !!result.uploadedVideo,
            hasVideoThumbnail: !!result.uploadedVideoThumbnail,
          });

          const cleanImages = (result.uploadedImages || []).map(normalizeKey);
          const cleanImageThumbnails = (
            result.uploadedImageThumbnails || []
          ).map(normalizeKey);
          const cleanVideo = normalizeKey(result.uploadedVideo);
          const cleanVideoThumbnail = normalizeKey(
            result.uploadedVideoThumbnail,
          );

          const updatedPost = await markCompleted(
            postId,
            cleanImages,
            cleanImageThumbnails,
            cleanVideo,
            cleanVideoThumbnail,
          );

          if (!updatedPost) {
            logger.warn({
              event: "mark_completed_null",
              postId,
            });
            return;
          }

          await publishProgress(postId, 100);

          const ownerId = updatedPost.user._id
            ? updatedPost.user._id.toString()
            : updatedPost.user.toString();

          // Fire‑and‑forget cache rebuild – do not await
          setImmediate(async () => {
            const cacheStart = Date.now();
            try {
              await bustAndRecache(postId, ownerId);
              logger.info({
                event: "cache_rebuilt",
                postId,
                durationMs: Date.now() - cacheStart,
              });
            } catch (err) {
              logger.error({
                event: "cache_rebuild_failed",
                postId,
                err,
              });
            }
          });

          logger.info({
            event: "media_processing_finished",
            postId,
            durationMs: Date.now() - jobStart,
          });
          return;
        }

        /* ================================================
           process-revolution-media
        ================================================ */
        if (name === "process-revolution-media") {
          const { revolutionId, rawFiles, version } = data;

          const revolution = await Revolution.findById(revolutionId);
          if (!revolution) return;

          if (
            version &&
            revolution.mediaVersion &&
            version < revolution.mediaVersion
          ) {
            logger.info({
              event: "stale_revolution_job_skipped",
              revolutionId,
            });
            return;
          }

          await publishProgress(revolutionId, 10);
          let last = 10;

          const result = await withTimeout(
            processMedia({
              files: rawFiles,
              onProgress: async (p) => {
                if (p >= last + 10 || p === 100) {
                  last = p;
                  await publishProgress(revolutionId, p);
                }
              },
            }),
          );

          const processed = (result.uploadedFiles || []).map(normalizeKey);
          const imageThumbnails = (result.uploadedImageThumbnails || []).map(
            normalizeKey,
          );
          const videoThumbnail = normalizeKey(result.uploadedVideoThumbnail);

          revolution.files.processed = processed;
          revolution.files.imageThumbnails = imageThumbnails;
          revolution.files.videoThumbnail = videoThumbnail;
          revolution.mediaStatus = "COMPLETED";

          await revolution.save();

          if (redis?.status === "ready") {
            await Promise.all([
              redis.del(`revolution:${revolutionId}`),
              redis.incr("revolutionfeed:version"),
            ]);
            await redis.set(
              `revolution:${revolutionId}`,
              JSON.stringify(revolution.toObject()),
              "EX",
              3600,
            );
          }

          await publishProgress(revolutionId, 100);
          return;
        }

        /* ================================================
           process-kyc-media
        ================================================ */
        if (name === "process-kyc-media") {
          const { kycId, frontImage, backImage, version } = data;

          const kyc = await kycDocument.findById(kycId);
          if (!kyc) {
            logger.warn({
              event: "kyc_deleted",
              kycId,
            });
            return;
          }

          if (version && kyc.mediaVersion && version < kyc.mediaVersion) {
            logger.info({
              event: "stale_kyc_job_skipped",
              kycId,
            });
            return;
          }

          await publishProgress(kycId, 10);
          let last = 10;

          const result = await withTimeout(
            processMedia({
              files: [frontImage, backImage].filter(Boolean),
              imageUploadPath: "kyc/compressed",
              onProgress: async (p) => {
                if (p >= last + 10 || p === 100) {
                  last = p;
                  await publishProgress(kycId, p);
                }
              },
            }),
          );

          const processed = (result.uploadedFiles || []).map(normalizeKey);
          const compressedFront = processed[0] || frontImage;
          const compressedBack = processed[1] || backImage;

          kyc.frontImage = compressedFront;
          kyc.backImage = compressedBack;
          kyc.mediaStatus = "COMPLETED";

          await kyc.save();

          if (redis?.status === "ready") {
            await redis.del(`kyc:${kycId}`);
          }

          await publishProgress(kycId, 100);
          logger.info({
            event: "kyc_processing_completed",
            kycId,
          });
          return;
        }

        /* ================================================
           process-profile-media
        ================================================ */
        if (name === "process-profile-media") {
          const { userId, profilePic, coverPic, version } = data;

          const user = await User.findById(userId);
          if (!user) {
            logger.warn({
              event: "user_deleted",
              userId,
            });
            return;
          }

          if (
            version &&
            user.profileMediaVersion &&
            version < user.profileMediaVersion
          ) {
            logger.info({
              event: "stale_profile_job_skipped",
              userId,
            });
            return;
          }

          await publishProgress(userId, 10);
          let last = 10;

          const result = await withTimeout(
            processMedia({
              files: [profilePic, coverPic].filter(Boolean),
              imageUploadPath: "profiles/compressed",
              onProgress: async (p) => {
                if (p >= last + 10 || p === 100) {
                  last = p;
                  await publishProgress(userId, p);
                }
              },
            }),
          );

          const processed = (result.uploadedFiles || []).map(normalizeKey);
          let index = 0;
          const updates = {};

          if (profilePic) {
            updates.profilePic = processed[index++] || profilePic;
            updates.profilePicStatus = "COMPLETED";
          }
          if (coverPic) {
            updates.coverPic = processed[index++] || coverPic;
            updates.coverPicStatus = "COMPLETED";
          }

          await User.updateOne({ _id: userId }, { $set: updates });

          if (redis?.status === "ready") {
            await Promise.all([
              redis.del(`user:me:${userId}`),
              redis.del(`user:profile:${userId}`),
            ]);
          }

          await publishProgress(userId, 100);
          logger.info({
            event: "profile_media_processing_completed",
            userId,
          });
          return;
        }

        logger.warn({
          event: "unknown_job_type",
          name,
        });
      } catch (err) {
        logger.error({
          err,
          jobId: job.id,
          queue: job.queueName,
          event: "job_failed",
          postId: job.data?.postId,
          revolutionId: job.data?.revolutionId,
          userId: job.data?.userId,
          kycId: job.data?.kycId,
        });

        if (job.attemptsMade === job.opts.attempts - 1) {
          try {
            if (job.name === "media-processing") {
              await markFailed(job.data.postId);
              await publishProgress(job.data.postId, -1);
              if (redis?.status === "ready") {
                await redis.del(`post:${job.data.postId}`);
              }
            }

            if (job.name === "process-revolution-media") {
              await Revolution.updateOne(
                { _id: job.data.revolutionId },
                { $set: { mediaStatus: "FAILED" } },
              );
              await publishProgress(job.data.revolutionId, -1);
            }

            if (job.name === "process-kyc-media") {
              await kycDocument.updateOne(
                { _id: job.data.kycId },
                { $set: { mediaStatus: "FAILED" } },
              );
              await publishProgress(job.data.kycId, -1);
            }

            if (job.name === "process-profile-media") {
              const updates = {};
              if (job.data.profilePic) updates.profilePicStatus = "FAILED";
              if (job.data.coverPic) updates.coverPicStatus = "FAILED";
              await User.updateOne({ _id: job.data.userId }, { $set: updates });
              await publishProgress(job.data.userId, -1);
            }
          } catch (e) {
            logger.error({
              err: e,
              event: "failure_handler",
              jobId: job.id,
            });
          }
        }

        throw err;
      }
    },
    {
      connection: redisQueueConfig,
      concurrency: 3,
      lockDuration: 900000,
      lockRenewTime: 60000,
      stalledInterval: 30000,
      maxStalledCount: 1,
    },
  );

  global.__mediaWorker.on("ready", () =>
    logger.info({
      event: "worker_ready",
    }),
  );
  global.__mediaWorker.on("active", (job) =>
    logger.info({
      event: "job_processing",
      jobId: job.id,
      queue: job.queueName,
    }),
  );
  global.__mediaWorker.on("completed", (job) =>
    logger.info({
      event: "job_completed",
      jobId: job.id,
      queue: job.queueName,
    }),
  );
  global.__mediaWorker.on("failed", (job, err) => {
    logger.error({
      event: "worker_failed",
      err,
      jobId: job?.id,
      queue: job?.queueName,
      attemptsMade: job?.attemptsMade,
    });
  });
  global.__mediaWorker.on("stalled", (jobId) => {
    logger.error({
      event: "job_stalled",
      jobId,
    });
  });
  global.__mediaWorker.on("error", (err) => {
    logger.fatal({
      event: "worker_error",
      err,
    });
  });

  logger.info({
    event: "worker_initialized",
  });
};

export const stopWorker = async () => {
  if (!global.__mediaWorker) return;

  await global.__mediaWorker.close();

  logger.info({
    event: "worker_stopped",
  });

  global.__mediaWorker = null;
};
