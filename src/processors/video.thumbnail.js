import ffmpeg from "fluent-ffmpeg";
import path from "path";

export const createVideoThumbnail = async (videoPath) => {
  const output = videoPath.replace(path.extname(videoPath), "-thumb.jpg");

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ["10%"],
        filename: path.basename(output),
        folder: path.dirname(output),
        size: "640x?",
      })
      .on("end", () => resolve(output))
      .on("error", reject);
  });
};
