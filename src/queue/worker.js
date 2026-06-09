import { Worker } from "bullmq";
import { redis, redisQueueConfig } from "../config/redis.js";
import { processMedia } from "../services/media.service.js";
import { markCompleted, markFailed } from "../services/post.service.js";
import { logger } from "../utils/logger.js";
import { Post } from "../models/post.model.js";
import { Revolution } from "../models/revolution.model.js";
import { Follow } from "../models/follow.model.js";
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
    logger.warn("Progress error", err.message);
  }
};

const withTimeout = (promise, ms = 1800000) =>
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

/**
 * After media processing completes:
 * 1. Delete the PROCESSING stub everyone was seeing
 * 2. Delete the creator's raw-key cache (from the patch in feed.controller)
 * 3. Re-cache a properly populated post so the next read is a cache HIT
 * 4. Ensure the post is in the correct feed sorted set
 * 5. Fanout: update all follower feed sorted sets
 */

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

    // Remove stale caches
    pipeline.del(`v1:post:${postIdStr}`);
    pipeline.del(`post:${postIdStr}`);
    pipeline.del(`post:${postIdStr}:creator:${ownerIdStr}`);

    // Re-cache fresh completed post
    pipeline.set(`v1:post:${postIdStr}`, JSON.stringify(cacheObj), "EX", 300);

    // Ensure feed references exist
    pipeline.zadd(`feed:user:${ownerIdStr}`, score, postIdStr);

    if (populated.feedType === "PUBLIC") {
      pipeline.zadd("feed:public", score, postIdStr);
    }

    if (populated.feedType === "PRIME") {
      pipeline.zadd("v1:feed:prime", score, postIdStr);
    }

    await pipeline.exec();

    await invalidatePublicFeedCache();

    // Bust shared first-page caches
    const sharedKeyPatterns = [
      "primefeed:v1:shared:ALL:*",
      "primefeed:v1:shared:NATIONAL:*",
    ];

    for (const pattern of sharedKeyPatterns) {
      try {
        const keys = await redis.keys(pattern);

        if (keys.length) {
          await redis.del(...keys);
        }
      } catch (err) {
        logger.warn(`Failed to bust shared cache: ${err.message}`);
      }
    }

    logger.info(`Cache busted and re-cached for post: ${postIdStr}`);
  } catch (err) {
    console.error("========== BUST CACHE ERROR ==========");
    console.error(err);
    console.error(err?.stack);

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
    console.log("Worker already running");
    return;
  }

  global.__mediaWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { name, data } = job;
      console.log("⚡ Job:", job.id, name);

      try {
        if (name === "media-processing") {
          const { postId, images, video, version } = data;

          const post = await Post.findById(postId).lean();

          if (!post) {
            logger.warn(`Post deleted, skipping job: ${postId}`);
            return;
          }

          if (version && post.mediaVersion && version < post.mediaVersion) {
            logger.info(`Skipping stale post job: ${postId}`);
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
            }),
          );

          const cleanImages = (result.uploadedImages || []).map(normalizeKey);
          const cleanVideo = normalizeKey(result.uploadedVideo);

          // markCompleted updates DB: sets images/video to compressed keys
          // and mediaStatus = "COMPLETED"
          const updatedPost = await markCompleted(
            postId,
            cleanImages,
            cleanVideo,
          );

          if (!updatedPost) {
            logger.warn(`markCompleted returned null for post: ${postId}`);
            return;
          }

          // ── THE FIX: bust stale cache and re-cache with populated user ──
          // await bustAndRecache(postId, updatedPost.user.toString());
          await bustAndRecache(
            postId,
            updatedPost.user._id
              ? updatedPost.user._id.toString()
              : updatedPost.user.toString(),
          );

          await publishProgress(postId, 100);
          return;
        }

        if (name === "process-revolution-media") {
          const { revolutionId, rawFiles, version } = data;

          const revolution = await Revolution.findById(revolutionId);
          if (!revolution) return;

          if (
            version &&
            revolution.mediaVersion &&
            version < revolution.mediaVersion
          ) {
            logger.info(`Skipping stale revolution job: ${revolutionId}`);
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

          revolution.files.processed = processed;
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

        if (name === "process-kyc-media") {
          const { kycId, frontImage, backImage, version } = data;

          const kyc = await kycDocument.findById(kycId);

          if (!kyc) {
            logger.warn(`KYC deleted, skipping job: ${kycId}`);
            return;
          }

          // Prevent stale jobs
          if (version && kyc.mediaVersion && version < kyc.mediaVersion) {
            logger.info(`Skipping stale KYC job: ${kycId}`);
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

          // Update DB with compressed keys
          kyc.frontImage = compressedFront;
          kyc.backImage = compressedBack;

          kyc.mediaStatus = "COMPLETED";

          await kyc.save();

          // Optional Redis cleanup
          if (redis?.status === "ready") {
            await redis.del(`kyc:${kycId}`);
          }

          await publishProgress(kycId, 100);

          logger.info(`KYC processing completed: ${kycId}`);

          return;
        }

        if (name === "process-profile-media") {
          const { userId, profilePic, coverPic, version } = data;

          const user = await User.findById(userId);

          if (!user) {
            logger.warn(`User deleted, skipping job: ${userId}`);
            return;
          }

          // Prevent stale jobs
          if (
            version &&
            user.profileMediaVersion &&
            version < user.profileMediaVersion
          ) {
            logger.info(`Skipping stale profile job: ${userId}`);
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

          if (profilePic) {
            user.profilePic = processed[index++] || profilePic;

            user.profilePicStatus = "COMPLETED";
          }

          if (coverPic) {
            user.coverPic = processed[index++] || coverPic;

            user.coverPicStatus = "COMPLETED";
          }

          await user.save();

          // Cache cleanup
          if (redis?.status === "ready") {
            await Promise.all([
              redis.del(`user:me:${userId}`),
              redis.del(`user:profile:${userId}`),
            ]);
          }

          await publishProgress(userId, 100);

          logger.info(`Profile media processing completed: ${userId}`);

          return;
        }

        logger.warn(`Unknown job type: ${name}`);
      } catch (err) {
        logger.error(`❌ Job failed: ${job.id}`, err);

        if (job.attemptsMade === job.opts.attempts - 1) {
          try {
            if (job.name === "media-processing") {
              await markFailed(job.data.postId);
              await publishProgress(job.data.postId, -1);

              // Clean up cache on final failure too
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
                {
                  $set: {
                    mediaStatus: "FAILED",
                  },
                },
              );

              await publishProgress(job.data.kycId, -1);
            }
            if (job.name === "process-profile-media") {
              const updates = {};

              if (job.data.profilePic) {
                updates.profilePicStatus = "FAILED";
              }

              if (job.data.coverPic) {
                updates.coverPicStatus = "FAILED";
              }

              await User.updateOne(
                {
                  _id: job.data.userId,
                },
                {
                  $set: updates,
                },
              );

              await publishProgress(job.data.userId, -1);
            }
          } catch (e) {
            logger.error("Failure handler error", e);
          }
        }

        throw err;
      }
    },
    {
      connection: redisQueueConfig,
      concurrency: 2,
      lockDuration: 300000,
      stalledInterval: 30000,
      maxStalledCount: 1,
    },
  );

  global.__mediaWorker.on("ready", () => console.log("🔥 Worker ready"));
  global.__mediaWorker.on("active", (job) =>
    console.log("Processing:", job.id),
  );
  global.__mediaWorker.on("completed", (job) =>
    console.log("✅ Completed:", job.id),
  );
  global.__mediaWorker.on("failed", (job, err) =>
    console.error("❌ Failed:", job?.id, err.message),
  );
  global.__mediaWorker.on("stalled", (jobId) => {
    console.error("🚨 STALLED JOB:", jobId);
  });

  global.__mediaWorker.on("error", (err) => {
    console.error("🚨 WORKER ERROR:", err);
  });

  console.log("Worker initialized");
};

export const stopWorker = async () => {
  if (global.__mediaWorker) {
    await global.__mediaWorker.close();
    global.__mediaWorker = null;
  }
};

// import { Worker } from "bullmq";
// import { redis, redisQueueConfig } from "../config/redis.js";
// import { processMedia } from "../services/media.service.js";
// import { markCompleted, markFailed } from "../services/post.service.js";
// import { logger } from "../utils/logger.js";
// import { Post } from "../models/post.model.js";
// import { Revolution } from "../models/revolution.model.js";

// const QUEUE_NAME = "media-processing";

// /* ------------------ SINGLE WORKER ------------------ */

// if (!global.__mediaWorker) global.__mediaWorker = null;

// /* ------------------ HELPERS ------------------ */

// const publishProgress = async (key, progress) => {
//   try {
//     if (redis?.status !== "ready") return;
//     await redis.set(`progress:${key}`, progress, "EX", 600);
//   } catch (err) {
//     logger.warn("Progress error", err.message);
//   }
// };

// const withTimeout = (promise, ms = 900000) =>
//   Promise.race([
//     promise,
//     new Promise((_, reject) =>
//       setTimeout(() => reject(new Error("Processing timeout")), ms),
//     ),
//   ]);

// const normalizeKey = (url) => {
//   if (!url) return null;
//   if (!url.startsWith("http")) return url;

//   try {
//     const parsed = new URL(url);
//     return parsed.searchParams.get("key") || url;
//   } catch {
//     return url;
//   }
// };

// /* ------------------ WORKER ------------------ */

// export const startWorker = () => {
//   if (global.__mediaWorker) {
//     console.log("Worker already running");
//     return;
//   }

//   global.__mediaWorker = new Worker(
//     QUEUE_NAME,
//     async (job) => {
//       const { name, data } = job;

//       console.log("⚡ Job:", job.id, name);

//       try {
//         if (name === "media-processing") {
//           const { postId, images, video, version } = data;

//           const post = await Post.findById(postId).lean();

//           if (!post) {
//             logger.warn(`Post deleted, skipping job: ${postId}`);
//             return;
//           }

//           if (version && post.mediaVersion && version < post.mediaVersion) {
//             logger.info(`Skipping stale post job: ${postId}`);
//             return;
//           }

//           await publishProgress(postId, 10);

//           let last = 10;

//           const result = await withTimeout(
//             processMedia({
//               images,
//               video,
//               onProgress: async (p) => {
//                 if (p >= last + 10 || p === 100) {
//                   last = p;
//                   await publishProgress(postId, p);
//                 }
//               },
//             }),
//           );

//           const cleanImages = (result.uploadedImages || []).map(normalizeKey);
//           const cleanVideo = normalizeKey(result.uploadedVideo);

//           const updatedPost = await markCompleted(
//             postId,
//             cleanImages,
//             cleanVideo,
//           );

//           // /* ---------- REDIS ---------- */
//           // if (updatedPost && redis?.status === "ready") {
//           //   const obj = updatedPost.toObject();

//           //   await redis.set(`post:${postId}`, JSON.stringify(obj), "EX", 3600);

//           //   const score = new Date(obj.createdAt).getTime();
//           //   await redis.zadd("feed:public", score, postId.toString());
//           // }

//           /* ---------- O(1) CACHE INVALIDATION ---------- */
//           if (redis?.status === "ready") {
//             await Promise.all([
//               redis.incr("publicfeed:version"), // replaces invalidatePattern
//               redis.del(`post:${postId}`), // still required
//             ]);
//           }

//           /* ---------- RE-CACHE ---------- */
//           if (updatedPost && redis?.status === "ready") {
//             const obj = updatedPost.toObject();

//             await redis.set(`post:${postId}`, JSON.stringify(obj), "EX", 3600);

//             const score = new Date(obj.createdAt).getTime();
//             await redis.zadd("feed:public", score, postId.toString());
//           }

//           await publishProgress(postId, 100);
//           return;
//         }

//         if (name === "process-revolution-media") {
//           const { revolutionId, rawFiles, version } = data;

//           const revolution = await Revolution.findById(revolutionId);
//           if (!revolution) return;

//           if (
//             version &&
//             revolution.mediaVersion &&
//             version < revolution.mediaVersion
//           ) {
//             logger.info(`Skipping stale revolution job: ${revolutionId}`);
//             return;
//           }

//           await publishProgress(revolutionId, 10);

//           let last = 10;

//           const result = await withTimeout(
//             processMedia({
//               files: rawFiles,
//               onProgress: async (p) => {
//                 if (p >= last + 10 || p === 100) {
//                   last = p;
//                   await publishProgress(revolutionId, p);
//                 }
//               },
//             }),
//           );

//           const processed = (result.uploadedFiles || []).map(normalizeKey);

//           revolution.files.processed = processed;
//           revolution.mediaStatus = "COMPLETED";

//           await revolution.save();

//           // /* ---------- REDIS ---------- */
//           // if (redis?.status === "ready") {
//           //   await redis.set(
//           //     `revolution:${revolutionId}`,
//           //     JSON.stringify(revolution.toObject()),
//           //     "EX",
//           //     3600,
//           //   );
//           // }

//           /* ---------- CACHE INVALIDATION ---------- */
//           if (redis?.status === "ready") {
//             await Promise.all([
//               redis.incr("revolutionfeed:version"), // O(1) invalidate all revolution feed caches
//               redis.del(`revolution:${revolutionId}`), // remove stale PROCESSING cache
//             ]);
//           }

//           /* ---------- RE-CACHE (OPTIONAL BUT GOOD) ---------- */
//           if (redis?.status === "ready") {
//             await redis.set(
//               `revolution:${revolutionId}`,
//               JSON.stringify(revolution.toObject()),
//               "EX",
//               3600,
//             );
//           }

//           await publishProgress(revolutionId, 100);
//           return;
//         }

//         logger.warn(`Unknown job type: ${name}`);
//       } catch (err) {
//         logger.error(`❌ Job failed: ${job.id}`, err);

//         /* ---------- FINAL FAILURE ---------- */
//         if (job.attemptsMade === job.opts.attempts - 1) {
//           try {
//             if (job.name === "media-processing") {
//               await markFailed(job.data.postId);
//               await publishProgress(job.data.postId, -1);
//             }

//             if (job.name === "process-revolution-media") {
//               await Revolution.updateOne(
//                 { _id: job.data.revolutionId },
//                 { $set: { mediaStatus: "FAILED" } },
//               );

//               await publishProgress(job.data.revolutionId, -1);
//             }
//           } catch (e) {
//             logger.error("Failure handler error", e);
//           }
//         }

//         throw err;
//       }
//     },
//     {
//       connection: redisQueueConfig,
//       concurrency: 1,
//       lockDuration: 600000,
//     },
//   );

//   /* ------------------ EVENTS ------------------ */

//   global.__mediaWorker.on("ready", () => console.log("🔥 Worker ready"));

//   global.__mediaWorker.on("active", (job) =>
//     console.log("Processing:", job.id),
//   );

//   global.__mediaWorker.on("completed", (job) =>
//     console.log("✅ Completed:", job.id),
//   );

//   global.__mediaWorker.on("failed", (job, err) =>
//     console.error("❌ Failed:", job?.id, err.message),
//   );

//   console.log("Worker initialized");
// };

// /* ------------------ STOP ------------------ */

// export const stopWorker = async () => {
//   if (global.__mediaWorker) {
//     await global.__mediaWorker.close();
//     global.__mediaWorker = null;
//   }
// };
