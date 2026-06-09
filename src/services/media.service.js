import path from "path";
import os from "os";
import crypto from "crypto";
import fs from "fs";

import { uploadFile } from "./upload.service.js";

import { downloadFromS3 } from "../utils/s3Download.js";
import { safeUnlink } from "../utils/cleanup.js";
import { retry } from "../utils/retry.js";
import { deleteFromS3 } from "../utils/s3Delete.js";

import { compressImageAdaptive } from "../processors/image.processor.js";
import { compressVideoAdaptive } from "../processors/video.processor.js";

export const processMedia = async ({
  // POSTS
  images = [],
  video = null,

  // REVOLUTION / KYC / FUTURE
  files = [],

  imageUploadPath = "feeds/images",
  videoUploadPath = "feeds/videos",

  onProgress = () => {},
}) => {
  const uploadedImages = [];
  const uploadedFiles = [];
  const uploadedVideos = [];

  let uploadedVideo = null;

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

    try {
      await retry(() => downloadFromS3(imgKey, localPath));

      compressed = await retry(() => compressImageAdaptive(localPath));

      const key = await retry(() => uploadFile(compressed, imageUploadPath));

      uploadedImages.push(key);
      uploadedFiles.push(key);

      await deleteFromS3(imgKey);

      const percent = Math.min(
        Math.round(((i + 1) / Math.max(totalImages, 1)) * 50),
        50,
      );

      await onProgress(percent);

      await safeUnlink(localPath);

      if (compressed) {
        await safeUnlink(compressed);
      }
    } catch (err) {
      await safeUnlink(localPath);

      if (compressed) {
        await safeUnlink(compressed);
      }

      throw err;
    }
  }

  // ----------------------------------------------------
  // PROCESS VIDEOS
  // ----------------------------------------------------

  // const totalVideos = videoList.length;

  // for (let i = 0; i < totalVideos; i++) {
  //   const videoKey = videoList[i];

  //   const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;

  //   const ext = path.extname(videoKey) || ".mp4";

  //   const localPath = path.join(tmpDir, `${uniqueName}${ext}`);

  //   let compressed = null;

  //   try {
  //     await retry(() => downloadFromS3(videoKey, localPath));

  //     await onProgress(70);

  //     compressed = await retry(() => compressVideoAdaptive(localPath));

  //     const uploadedKey = await retry(() =>
  //       uploadFile(compressed, videoUploadPath),
  //     );

  //     uploadedVideos.push(uploadedKey);
  //     uploadedFiles.push(uploadedKey);

  //     // Backward compatibility for Posts
  //     if (!uploadedVideo) {
  //       uploadedVideo = uploadedKey;
  //     }

  //     await deleteFromS3(videoKey);

  //     await onProgress(95);

  //     await safeUnlink(localPath);

  //     if (compressed) {
  //       await safeUnlink(compressed);
  //     }
  //   } catch (err) {
  //     await safeUnlink(localPath);

  //     if (compressed) {
  //       await safeUnlink(compressed);
  //     }

  //     throw err;
  //   }
  // }

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

    try {
      // console.log("\n========== VIDEO PROCESSING START ==========");
      // console.log("Original S3 Key:", videoKey);
      // console.log("Local Path:", localPath);

      await retry(() => downloadFromS3(videoKey, localPath));

      const downloadedStat = await fs.promises.stat(localPath);

      // console.log(
      //   "Downloaded Size:",
      //   (downloadedStat.size / 1024 / 1024).toFixed(2),
      //   "MB",
      // );

      await onProgress(70);

      // console.log("Starting compression...");

      compressed = await retry(() => compressVideoAdaptive(localPath));

      const compressedStat = await fs.promises.stat(compressed);

      // console.log("Compressed File:", compressed);

      // console.log(
      //   "Compressed Size:",
      //   (compressedStat.size / 1024 / 1024).toFixed(2),
      //   "MB",
      // );

      // console.log(
      //   "Reduction:",
      //   ((1 - compressedStat.size / downloadedStat.size) * 100).toFixed(2) +
      //     "%",
      // );

      // console.log("Uploading compressed file...");

      const uploadedKey = await retry(() =>
        uploadFile(compressed, videoUploadPath),
      );

      // console.log("Uploaded Key:", uploadedKey);

      uploadedVideos.push(uploadedKey);
      uploadedFiles.push(uploadedKey);

      // Backward compatibility for Posts
      if (!uploadedVideo) {
        uploadedVideo = uploadedKey;
      }

      // console.log("Deleting original video from Spaces...");
      // console.log("Original Key:", videoKey);

      await deleteFromS3(videoKey);

      // console.log("Original deleted successfully");

      await onProgress(95);

      await safeUnlink(localPath);

      if (compressed) {
        await safeUnlink(compressed);
      }

      // console.log("Temporary files removed");
    } catch (err) {
      console.error(err);

      await safeUnlink(localPath);

      if (compressed) {
        await safeUnlink(compressed);
      }

      throw err;
    }
  }

  await onProgress(100);

  return {
    uploadedImages,
    uploadedFiles,
    uploadedVideos,
    uploadedVideo,
  };
};

// import path from "path";
// import os from "os";
// import crypto from "crypto";

// import { uploadFile } from "./upload.service.js";

// import { downloadFromS3 } from "../utils/s3Download.js";
// import { safeUnlink } from "../utils/cleanup.js";
// import { retry } from "../utils/retry.js";
// import { deleteFromS3 } from "../utils/s3Delete.js";

// import { compressImageAdaptive } from "../processors/image.processor.js";
// import { compressVideoAdaptive } from "../processors/video.processor.js";

// // ─────────────────────────────────────────────────────────────
// // PROCESS MEDIA
// // Supports:
// // - Posts
// // - KYC Documents
// // - Revolutions
// // - Future media types
// // ─────────────────────────────────────────────────────────────

// export const processMedia = async ({
//   // POSTS
//   images = [],
//   video = null,

//   // GENERIC FILES (KYC / REVOLUTION / FUTURE)
//   files = [],

//   // CUSTOM UPLOAD PATHS
//   imageUploadPath = "feeds/images",
//   videoUploadPath = "feeds/videos",

//   onProgress = () => {},
// }) => {
//   const uploadedImages = [];
//   const uploadedFiles = [];

//   let uploadedVideo = null;

//   const tmpDir = os.tmpdir();

//   const imageList = files.length > 0 ? files : images;

//   // PROCESS IMAGES ─────────────────────────────────────────────────────

//   const totalImages = imageList.length;

//   for (let i = 0; i < totalImages; i++) {
//     const imgKey = imageList[i];

//     const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;

//     // Dynamic extension support
//     const ext = path.extname(imgKey) || ".jpg";

//     const localPath = path.join(tmpDir, `${uniqueName}${ext}`);

//     let compressed = null;

//     try {
//       // Download RAW from S3 ─────────────────────────────

//       await retry(() => downloadFromS3(imgKey, localPath));

//       // Compress image ─────────────────────────────

//       compressed = await retry(() => compressImageAdaptive(localPath));

//       // Upload compressed image ─────────────────────────────

//       const key = await retry(() => uploadFile(compressed, imageUploadPath));

//       uploadedImages.push(key);
//       uploadedFiles.push(key);

//       // Delete RAW S3 file ─────────────────────────────

//       await deleteFromS3(imgKey);

//       // Progress update ─────────────────────────────

//       const percent = Math.min(Math.round(((i + 1) / totalImages) * 80), 80);

//       await onProgress(percent);

//       // Cleanup temp files ─────────────────────────────

//       await safeUnlink(localPath);

//       if (compressed) {
//         await safeUnlink(compressed);
//       }
//     } catch (err) {
//       // Cleanup on failure

//       await safeUnlink(localPath);

//       if (compressed) {
//         await safeUnlink(compressed);
//       }

//       throw err;
//     }
//   }

//   // PROCESS VIDEO ─────────────────────────────────────────────────────

//   if (video) {
//     const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;

//     const ext = path.extname(video) || ".mp4";

//     const localPath = path.join(tmpDir, `${uniqueName}${ext}`);

//     let compressed = null;

//     try {
//       // Download RAW video ─────────────────────────────

//       await retry(() => downloadFromS3(video, localPath));

//       await onProgress(70);

//       // Compress video ─────────────────────────────

//       compressed = await retry(() => compressVideoAdaptive(localPath));

//       // Upload compressed video ─────────────────────────────

//       uploadedVideo = await retry(() =>
//         uploadFile(compressed, videoUploadPath),
//       );

//       // Delete RAW video ─────────────────────────────

//       await deleteFromS3(video);

//       await onProgress(95);

//       // Cleanup ─────────────────────────────

//       await safeUnlink(localPath);

//       if (compressed) {
//         await safeUnlink(compressed);
//       }
//     } catch (err) {
//       await safeUnlink(localPath);

//       if (compressed) {
//         await safeUnlink(compressed);
//       }

//       throw err;
//     }
//   }

//   // FINAL RESPONSE ─────────────────────────────────────────────────────

//   return {
//     uploadedImages,
//     uploadedFiles,
//     uploadedVideo,
//   };
// };
