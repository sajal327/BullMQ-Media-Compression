import sharp from "sharp";
import path from "path";

export const createImageThumbnail = async (inputPath) => {
  const output = inputPath.replace(path.extname(inputPath), "-thumb.webp");

  await sharp(inputPath)
    .resize({
      width: 500,
      height: 500,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: 72,
      effort: 3,
    })
    .toFile(output);

  return output;
};
