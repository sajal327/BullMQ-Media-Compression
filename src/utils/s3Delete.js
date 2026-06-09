import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET } from "../config/s3.js";

export const deleteFromS3 = async (key) => {
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );
  } catch (err) {
    console.warn("S3 delete failed:", err.message);
  }
};
