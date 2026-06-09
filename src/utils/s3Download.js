import fs from "fs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET } from "../config/s3.js";

export const downloadFromS3 = async (key, outputPath) => {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
  );

  const stream = response.Body;

  await new Promise((resolve, reject) => {
    const write = fs.createWriteStream(outputPath);
    stream.pipe(write);

    stream.on("error", reject);
    write.on("finish", resolve);
  });

  return outputPath;
};
