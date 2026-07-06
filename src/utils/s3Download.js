import fs from "fs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKET } from "../config/s3.js";
import { logger } from "./logger.js";

export const downloadFromS3 = async (
  key,
  outputPath,
  inactivityTimeoutMs = 90000,
) => {
  const started = Date.now();

  let response;

  try {
    logger.info({
      event: "s3_get_object_start",
      key,
    });

    response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );

    logger.info({
      event: "s3_get_object_success",
      key,
    });
  } catch (err) {
    logger.error({
      event: "s3_getobject_error",
      key,
      name: err.name,
      code: err.code,
      message: err.message,
      statusCode: err.$metadata?.httpStatusCode,
      requestId: err.$metadata?.requestId,
      extendedRequestId: err.$metadata?.extendedRequestId,
      attempts: err.$metadata?.attempts,
      totalRetryDelay: err.$metadata?.totalRetryDelay,
      err,
    });

    throw new Error(
      `S3 GetObject failed for "${key}": ${err.name}: ${err.message}`,
    );
  }

  const stream = response.Body;

  if (!stream) {
    throw new Error(`S3 returned empty body for key: ${key}`);
  }

  const expectedBytes = Number(response.ContentLength || 0);

  await new Promise((resolve, reject) => {
    const write = fs.createWriteStream(outputPath);

    let finished = false;
    let timer = null;
    let bytesReceived = 0;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;

      cleanup();

      if (!stream.destroyed) {
        stream.destroy(err);
      }

      if (!write.destroyed) {
        write.destroy();
      }

      fs.unlink(outputPath, () => {});

      reject(err);
    };

    const success = () => {
      if (finished) return;
      finished = true;

      cleanup();

      const seconds = (Date.now() - started) / 1000;

      const downloadedMB = (bytesReceived / 1024 / 1024).toFixed(2);

      const speed =
        seconds > 0 ? (bytesReceived / 1024 / 1024 / seconds).toFixed(2) : "0";

      if (expectedBytes && bytesReceived !== expectedBytes) {
        return reject(
          new Error(
            `Incomplete download for "${key}". Expected ${expectedBytes} bytes, got ${bytesReceived} bytes.`,
          ),
        );
      }

      logger.info({
        event: "s3_download_complete",
        key,
        downloadedMB,
        seconds: Number(seconds.toFixed(1)),
        speedMBps: Number(speed),
      });

      resolve();
    };

    const resetTimer = () => {
      cleanup();

      timer = setTimeout(() => {
        fail(
          new Error(
            `Download stalled after ${(bytesReceived / 1024 / 1024).toFixed(
              2,
            )} MB (no data for ${inactivityTimeoutMs / 1000}s) | ${key}`,
          ),
        );
      }, inactivityTimeoutMs);
    };

    resetTimer();

    stream.on("data", (chunk) => {
      bytesReceived += chunk.length;
      resetTimer();
    });

    stream.on("error", (err) => {
      logger.error({
        event: "s3_stream_error",
        key,
        name: err.name,
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        message: err.message,
        cause: err.cause,
        bytesReceived,
        expectedBytes,
        stack: err.stack,
      });

      fail(err);
    });

    write.on("error", (err) => {
      fail(new Error(`File write error "${outputPath}": ${err.message}`));
    });

    write.on("finish", success);

    write.on("close", () => {
      if (!finished && !write.writableFinished) {
        fail(new Error(`Write stream closed unexpectedly for key: ${key}`));
      }
    });

    stream.pipe(write);
  });

  return outputPath;
};

// import fs from "fs";
// import { GetObjectCommand } from "@aws-sdk/client-s3";
// import { s3, BUCKET } from "../config/s3.js";

// export const downloadFromS3 = async (key, outputPath) => {
//   const response = await s3.send(
//     new GetObjectCommand({
//       Bucket: BUCKET,
//       Key: key,
//     }),
//   );

//   const stream = response.Body;

//   await new Promise((resolve, reject) => {
//     const write = fs.createWriteStream(outputPath);
//     stream.pipe(write);

//     stream.on("error", reject);
//     write.on("finish", resolve);
//   });

//   return outputPath;
// };
