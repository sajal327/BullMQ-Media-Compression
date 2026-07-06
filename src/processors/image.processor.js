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
