import fs from "fs";
import path from "path";
import { Upload } from "@aws-sdk/lib-storage";
import { s3, BUCKET } from "../config/s3.js";

export const uploadFile = async (filePath, folder) => {
  const stream = fs.createReadStream(filePath);
  const key = `${folder}/${Date.now()}-${path.basename(filePath)}`;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: stream,
      ACL: "public-read",
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });

  await upload.done();
  await fs.promises.unlink(filePath).catch(() => {});
  return key;
};
