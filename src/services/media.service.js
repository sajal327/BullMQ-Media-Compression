import path from "path";
import os from "os";
import crypto from "crypto";
import fs from "fs";
import { logger } from "../utils/logger.js";
import { uploadFile } from "./upload.service.js";
import { downloadFromS3 } from "../utils/s3Download.js";
import { safeUnlink } from "../utils/cleanup.js";
import { retry } from "../utils/retry.js";
import { deleteFromS3 } from "../utils/s3Delete.js";
import { compressImageAdaptive } from "../processors/image.processor.js";
import { compressVideoAdaptive } from "../processors/video.processor.js";
import { createImageThumbnail } from "../processors/image.thumbnail.js";
import { createVideoThumbnail } from "../processors/video.thumbnail.js";

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

export const processMedia = async ({
  images = [],
  video = null,
  files = [],
  imageUploadPath = "feeds/images",
  videoUploadPath = "feeds/videos",
  onProgress = () => {},
  onEarlyImageThumbnails = null,
  onEarlyVideoThumbnail = null,
}) => {
  logger.info({
    event: "process_media_started",
    imageCount: images?.length ?? 0,
    videoCount: video ? 1 : 0,
    filesCount: files?.length ?? 0,
    imageUploadPath,
    videoUploadPath,
  });

  const uploadedImages = [];
  const uploadedFiles = [];
  const uploadedVideos = [];

  let uploadedVideo = null;
  const uploadedImageThumbnails = [];
  let uploadedVideoThumbnail = null;

  const tmpDir = os.tmpdir();

  // ----------------------------------------------------
  // AUTO-DETECT FILE TYPES
  // ----------------------------------------------------

  const imageList =
    files.length > 0
      ? files.filter(
          (f) => f.includes("/image/") || /\.(jpg|jpeg|png|webp)$/i.test(f),
        )
      : images;

  const videoList =
    files.length > 0
      ? files.filter(
          (f) => f.includes("/video/") || /\.(mp4|mov|avi|webm|mkv)$/i.test(f),
        )
      : video
        ? [video]
        : [];

  logger.info({
    event: "media_files_detected",
    imageCount: imageList.length,
    videoCount: videoList.length,
  });

  // ----------------------------------------------------
  // PROCESS IMAGES
  // ----------------------------------------------------

  const totalImages = imageList.length;

  for (let i = 0; i < totalImages; i++) {
    const imgKey = imageList[i];
    const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;
    const ext = path.extname(imgKey) || ".jpg";
    const localPath = path.join(tmpDir, `${uniqueName}${ext}`);

    let compressed = null;
    let thumbnail = null;

    try {
      // 1. Download
      const downloadStart = Date.now();
      await retry(() => downloadFromS3(imgKey, localPath));
      logger.debug({
        event: "image_downloaded",
        key: imgKey,
        index: i + 1,
        total: totalImages,
        durationMs: Date.now() - downloadStart,
      });

      // 2. Compress
      const compressStart = Date.now();
      compressed = await retry(() => compressImageAdaptive(localPath));
      logger.debug({
        event: "image_compressed",
        key: imgKey,
        index: i + 1,
        total: totalImages,
        durationMs: Date.now() - compressStart,
      });

      // 3. Generate thumbnail from compressed
      const thumbStart = Date.now();
      thumbnail = await retry(() => createImageThumbnail(compressed));
      logger.debug({
        event: "image_thumbnail_created",
        key: imgKey,
        index: i + 1,
        total: totalImages,
        durationMs: Date.now() - thumbStart,
      });

      // 4. Upload thumbnail + compressed in parallel
      const uploadStart = Date.now();
      const [thumbKey, key] = await Promise.all([
        retry(() => uploadFile(thumbnail, "feeds/thumbnails/images")),
        retry(() => uploadFile(compressed, imageUploadPath)),
      ]);
      logger.debug({
        event: "image_uploaded",
        key: imgKey,
        compressedKey: key,
        thumbnailKey: thumbKey,
        index: i + 1,
        total: totalImages,
        durationMs: Date.now() - uploadStart,
      });

      const normalizedKey = normalizeKey(key);
      const normalizedThumb = normalizeKey(thumbKey);

      uploadedImages.push(normalizedKey);
      uploadedImageThumbnails.push(normalizedThumb);
      uploadedFiles.push(normalizedKey);

      // 5. Fire early callback — non‑blocking, safely handles sync/async
      if (onEarlyImageThumbnails) {
        Promise.resolve(
          onEarlyImageThumbnails([...uploadedImageThumbnails]),
        ).catch((err) => {
          logger.warn({
            event: "early_thumbnail_callback_failed",
            err,
          });
        });
      }

      // 6. Delete original – awaited with retry
      const deleteStart = Date.now();
      await retry(() => deleteFromS3(imgKey));
      logger.debug({
        event: "original_image_deleted",
        key: imgKey,
        index: i + 1,
        total: totalImages,
        durationMs: Date.now() - deleteStart,
      });

      // Progress: first 50% is images
      const progress = Math.min(Math.round(((i + 1) / totalImages) * 50), 50);
      await onProgress(progress);

      // Cleanup temp files
      await safeUnlink(localPath).catch(() => {});
      await safeUnlink(compressed).catch(() => {});
      await safeUnlink(thumbnail).catch(() => {});
    } catch (err) {
      logger.error({
        event: "image_processing_failed",
        key: imgKey,
        index: i + 1,
        total: totalImages,
        err,
      });

      await safeUnlink(localPath).catch(() => {});
      if (compressed) await safeUnlink(compressed).catch(() => {});
      if (thumbnail) await safeUnlink(thumbnail).catch(() => {});

      throw err;
    }
  }

  // If no images, push progress to 50% anyway
  if (totalImages === 0) {
    await onProgress(50);
  }

  // ----------------------------------------------------
  // PROCESS VIDEOS
  // ----------------------------------------------------

  const totalVideos = videoList.length;

  for (let i = 0; i < totalVideos; i++) {
    const videoKey = videoList[i];
    const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;
    const ext = path.extname(videoKey) || ".mp4";
    const localPath = path.join(tmpDir, `${uniqueName}${ext}`);

    let compressed = null;
    let thumbnail = null;

    try {
      // 1. Download
      const downloadStart = Date.now();
      await retry(() => downloadFromS3(videoKey, localPath));
      const stat = await fs.promises.stat(localPath);
      logger.debug({
        event: "video_downloaded",
        key: videoKey,
        index: i + 1,
        total: totalVideos,
        sizeMB: (stat.size / 1024 / 1024).toFixed(2),
        durationMs: Date.now() - downloadStart,
      });

      await onProgress(50);

      // 2. Generate thumbnail from original (before compression)
      const thumbStart = Date.now();
      thumbnail = await retry(() => createVideoThumbnail(localPath));
      logger.debug({
        event: "video_thumbnail_created",
        key: videoKey,
        index: i + 1,
        total: totalVideos,
        durationMs: Date.now() - thumbStart,
      });

      // 3. Upload thumbnail immediately
      const uploadThumbStart = Date.now();
      const thumbKey = await retry(() =>
        uploadFile(thumbnail, "feeds/thumbnails/videos"),
      );
      logger.debug({
        event: "video_thumbnail_uploaded",
        key: videoKey,
        thumbnailKey: thumbKey,
        index: i + 1,
        total: totalVideos,
        durationMs: Date.now() - uploadThumbStart,
      });

      const normalizedThumb = normalizeKey(thumbKey);
      uploadedVideoThumbnail = normalizedThumb;

      // 4. Fire early callback — non‑blocking, safely handles sync/async
      if (onEarlyVideoThumbnail) {
        Promise.resolve(onEarlyVideoThumbnail(normalizedThumb)).catch((err) => {
          logger.warn({
            event: "early_video_thumbnail_callback_failed",
            err,
          });
        });
      }

      await onProgress(60);

      // 5. Compress (longest step)
      const compressStart = Date.now();
      compressed = await retry(() => compressVideoAdaptive(localPath));
      const compStat = await fs.promises.stat(compressed);
      logger.debug({
        event: "video_compressed",
        key: videoKey,
        index: i + 1,
        total: totalVideos,
        sizeMB: (compStat.size / 1024 / 1024).toFixed(2),
        durationMs: Date.now() - compressStart,
      });

      await onProgress(85);

      // 6. Upload compressed
      const uploadCompStart = Date.now();
      const uploadedKey = await retry(() =>
        uploadFile(compressed, videoUploadPath),
      );
      logger.debug({
        event: "video_compressed_uploaded",
        key: videoKey,
        compressedKey: uploadedKey,
        index: i + 1,
        total: totalVideos,
        durationMs: Date.now() - uploadCompStart,
      });

      const normalizedKey = normalizeKey(uploadedKey);
      uploadedVideos.push(normalizedKey);
      uploadedFiles.push(normalizedKey);
      if (!uploadedVideo) {
        uploadedVideo = normalizedKey;
      }

      // 7. Delete original – awaited with retry
      const deleteStart = Date.now();
      await retry(() => deleteFromS3(videoKey));
      logger.debug({
        event: "original_video_deleted",
        key: videoKey,
        index: i + 1,
        total: totalVideos,
        durationMs: Date.now() - deleteStart,
      });

      await onProgress(95);

      // Cleanup temp files
      await safeUnlink(localPath).catch(() => {});
      await safeUnlink(compressed).catch(() => {});
      await safeUnlink(thumbnail).catch(() => {});
    } catch (err) {
      logger.error({
        event: "video_processing_failed",
        key: videoKey,
        index: i + 1,
        total: totalVideos,
        err,
      });

      await safeUnlink(localPath).catch(() => {});
      if (compressed) await safeUnlink(compressed).catch(() => {});
      if (thumbnail) await safeUnlink(thumbnail).catch(() => {});

      throw err;
    }
  }

  // If no videos, we still progress to 100
  await onProgress(100);

  logger.info({
    event: "process_media_completed",
    uploadedImageCount: uploadedImages.length,
    uploadedThumbnailCount: uploadedImageThumbnails.length,
    uploadedVideoCount: uploadedVideos.length,
    hasVideoThumbnail: !!uploadedVideoThumbnail,
  });

  return {
    uploadedImages,
    uploadedImageThumbnails,
    uploadedFiles,
    uploadedVideos,
    uploadedVideo,
    uploadedVideoThumbnail,
  };
};
