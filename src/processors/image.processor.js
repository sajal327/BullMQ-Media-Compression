import sharp from "sharp";
import fs from "fs";
import path from "path";
import heicConvert from "heic-convert";
import { fileTypeFromBuffer } from "file-type";
import crypto from "crypto";

sharp.concurrency(2);

export const compressImageAdaptive = async (filePath) => {
  try {
    let buffer = await fs.promises.readFile(filePath);

    const type = await fileTypeFromBuffer(buffer);
    const ext = type?.ext || "jpg";

    // HEIC / HEIF → JPEG
    if (ext === "heic" || ext === "heif") {
      buffer = await heicConvert({
        buffer,
        format: "JPEG",
        quality: 0.95,
      });
    }

    const stat = await fs.promises.stat(filePath);
    const sizeMB = stat.size / (1024 * 1024);

    const image = sharp(buffer, {
      failOnError: false,
    }).rotate();

    const metadata = await image.metadata();
    const width = metadata.width || 0;

    // Skip already optimized small images
    // if (sizeMB < 1 && width <= 1280) {
    //   return filePath;
    // }

    const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;
    const output = path.join(
      path.dirname(filePath),
      `${uniqueName}-compressed.webp`,
    );

    let pipeline = image;

    // Resize large images
    if (width > 1080) {
      pipeline = pipeline.resize({
        width: 1080,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    let quality = 80;
    let effort = 3;

    if (sizeMB < 1) {
      quality = 82;
      effort = 2;
    } else if (sizeMB < 5) {
      quality = 78;
      effort = 3;
    } else {
      quality = 72;
      effort = 4;
    }

    await pipeline
      .webp({
        quality,
        effort,
        smartSubsample: true,
      })
      .toFile(output);

    await fs.promises.unlink(filePath).catch(() => {});

    return output;
  } catch (err) {
    console.error("Image processing error:", err.message);
    return filePath;
  }
};

// import sharp from "sharp";
// import fs from "fs";
// import path from "path";
// import heicConvert from "heic-convert";
// import { fileTypeFromBuffer } from "file-type";
// import crypto from "crypto";

// sharp.concurrency(2);

// export const compressImageAdaptive = async (filePath) => {
//   let buffer;
//   let ext = "jpg";

//   try {
//     buffer = await fs.promises.readFile(filePath);

//     const type = await fileTypeFromBuffer(buffer);
//     ext = type?.ext || "jpg";

//     // HEIC → JPEG
//     if (ext === "heic" || ext === "heif") {
//       buffer = await heicConvert({
//         buffer,
//         format: "JPEG",
//         quality: 0.95,
//       });
//       ext = "jpg";
//     }

//     const stat = await fs.promises.stat(filePath);
//     const sizeMB = stat.size / (1024 * 1024);

//     const image = sharp(buffer, { failOnError: false }).rotate();
//     const metadata = await image.metadata();

//     const width = metadata.width || 0;
//     // const hasAlpha = metadata.hasAlpha || false;

//     const uniqueName = `${Date.now()}-${crypto.randomUUID()}`;
//     const output = path.join(
//       path.dirname(filePath),
//       `${uniqueName}-compressed.webp`,
//     );

//     // let pipeline = image.withMetadata(false);

//     let pipeline = image;

//     // SAFE SKIP (copy instead of rename)
//     if (sizeMB < 1 && width <= 1280) {
//       await fs.promises.copyFile(filePath, output);
//       await fs.promises.unlink(filePath).catch(() => {});
//       return output;
//     }

//     // Resize
//     if (width > 1920) {
//       pipeline = pipeline.resize({
//         width: 1920,
//         fit: "inside",
//         withoutEnlargement: true,
//       });
//     }

//     // Quality
//     let quality = 85;
//     let effort = 4;

//     if (sizeMB < 1) {
//       quality = 90;
//       effort = 2;
//     } else if (sizeMB < 5) {
//       quality = 85;
//       effort = 3;
//     } else {
//       quality = 80;
//       effort = 4;
//     }

//     // PNG fallback
//     // if (hasAlpha && sizeMB < 2) {
//     //   const pngOutput = output.replace(".webp", ".png");

//     //   await pipeline
//     //     .png({
//     //       compressionLevel: 9,
//     //       adaptiveFiltering: true,
//     //     })
//     //     .toFile(pngOutput);

//     //   await fs.promises.unlink(filePath).catch(() => {});
//     //   return pngOutput;
//     // }
//     await pipeline
//       .webp({
//         quality,
//         effort,
//         smartSubsample: true,
//       })
//       .toFile(output);

//     // await pipeline.webp({ quality, effort }).toFile(output);

//     await fs.promises.unlink(filePath).catch(() => {});

//     return output;
//   } catch (err) {
//     console.error("Image processing error:", err.message);
//     return filePath;
//   }
// };
