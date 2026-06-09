import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

const probe = (input) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

export const compressVideoAdaptive = async (input) => {
  const meta = await probe(input);

  const videoStream = meta.streams.find((s) => s.codec_type === "video");

  const duration = Number(meta.format.duration || 1);
  const sizeMB = Number(meta.format.size || 0) / (1024 * 1024);

  const width = videoStream?.width || 720;
  const height = videoStream?.height || 0;

  const originalCodec = videoStream?.codec_name || "unknown";

  const originalBitrate = Math.round(Number(meta.format.bit_rate || 0) / 1000);

  const output = input.replace(path.extname(input), "-compressed.mp4");

  // Duration-based bitrate strategy
  let videoBitrate;

  if (duration < 30) {
    videoBitrate = 900;
  } else if (duration < 60) {
    videoBitrate = 650;
  } else if (duration < 120) {
    videoBitrate = 500;
  } else {
    videoBitrate = 400;
  }

  // Preserve quality for huge uploads
  // if (sizeMB > 50) {
  //   videoBitrate = Math.max(videoBitrate, 1500);
  // }

  // if (sizeMB > 100) {
  //   videoBitrate = Math.max(videoBitrate, 2000);
  // }

  // const scale = width > 720 ? "scale=720:-2" : "scale=iw:-2";
  const scale = width > 640 ? "scale=640:-2" : "scale=iw:-2";

  // console.log("\n========== VIDEO ANALYSIS ==========");
  // console.log("Input File:", input);
  // console.log("Duration:", duration, "seconds");
  // console.log("Original Size:", sizeMB.toFixed(2), "MB");
  // console.log("Resolution:", `${width}x${height}`);
  // console.log("Codec:", originalCodec);
  // console.log("Original Bitrate:", originalBitrate, "kbps");
  // console.log("Target Bitrate:", videoBitrate, "kbps");
  // console.log("Scale Filter:", scale);
  // console.log("Output File:", output);
  // console.log("====================================\n");

  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-preset veryfast",

        // AVC
        "-profile:v high",
        "-level:v 4.0",
        "-pix_fmt yuv420p",

        // Normalize FPS
        "-r 30",

        // Bitrate
        `-b:v ${videoBitrate}k`,
        `-maxrate ${Math.floor(videoBitrate * 1.2)}k`,
        `-bufsize ${videoBitrate * 2}k`,

        // Audio
        "-b:a 64k",
        "-ac 2",

        // Resize
        `-vf ${scale}`,

        // Fast start
        "-movflags +faststart",

        "-threads 0",
      ])
      .on("start", (cmd) => {
        // console.log("\n========== FFMPEG START ==========");
        // console.log(cmd);
        // console.log("==================================\n");
      })
      .on("end", async () => {
        try {
          const originalStat = await fs.promises.stat(input);

          const compressedStat = await fs.promises.stat(output);

          const originalMB = originalStat.size / 1024 / 1024;

          const compressedMB = compressedStat.size / 1024 / 1024;

          const saved = originalMB - compressedMB;

          const ratio = ((saved / originalMB) * 100).toFixed(2);

          // console.log("\n========== COMPRESSION RESULT ==========");

          // console.log("Original:", originalMB.toFixed(2), "MB");

          // console.log("Compressed:", compressedMB.toFixed(2), "MB");

          // console.log("Saved:", saved.toFixed(2), "MB");

          // console.log("Reduction:", ratio + "%");

          // console.log("========================================\n");

          await fs.promises.unlink(input).catch(() => {});

          resolve(output);
        } catch (err) {
          reject(err);
        }
      })
      .on("error", async (err) => {
        // console.error("\n========== FFMPEG ERROR ==========");
        // console.error(err);
        // console.error("==================================\n");

        await fs.promises.unlink(input).catch(() => {});

        reject(err);
      })
      .save(output);
  });
};

// import ffmpeg from "fluent-ffmpeg";
// import fs from "fs";
// import path from "path";

// const probe = (input) =>
//   new Promise((resolve, reject) => {
//     ffmpeg.ffprobe(input, (err, data) => {
//       if (err) return reject(err);
//       resolve(data);
//     });
//   });

// export const compressVideoAdaptive = async (input) => {
//   const meta = await probe(input);

//   const videoStream = meta.streams.find((s) => s.codec_type === "video");
//   const format = meta.format;

//   const width = videoStream?.width || 0;
//   const bitrate = parseInt(format?.bit_rate || "0", 10);
//   const sizeMB = (format?.size || 0) / (1024 * 1024);

//   const output = input.replace(path.extname(input), "-compressed.mp4");

//   // Skip already optimized videos
//   const isSmall = sizeMB < 15 && width <= 1280;

//   const isEfficient = bitrate > 0 && bitrate < 1_800_000 && width <= 1280;

//   if (isSmall && isEfficient) {
//     return new Promise((resolve, reject) => {
//       ffmpeg(input)
//         .outputOptions(["-c copy", "-movflags +faststart"])
//         .on("end", async () => {
//           await fs.promises.unlink(input).catch(() => {});
//           resolve(output);
//         })
//         .on("error", reject)
//         .save(output);
//     });
//   }

//   // Scaling
//   let scaleFilter = null;

//   if (width > 720) {
//     scaleFilter = "scale=720:-2";
//   }

//   // CRF
//   let crf = 24;

//   if (sizeMB > 200) {
//     crf = 27;
//   } else if (sizeMB > 100) {
//     crf = 26;
//   }

//   const preset = "veryfast";
//   const threads = 0;

//   return new Promise((resolve, reject) => {
//     const cmd = ffmpeg(input).outputOptions([
//       "-c:v libx264",
//       `-preset ${preset}`,
//       `-crf ${crf}`,
//       `-threads ${threads}`,
//       "-c:a aac",
//       "-b:a 64k",
//       "-movflags +faststart",
//     ]);

//     if (scaleFilter) {
//       cmd.outputOptions([`-vf ${scaleFilter}`]);
//     }

//     cmd
//       .on("start", (command) => {
//         console.log("FFmpeg:", command);
//       })
//       .on("end", async () => {
//         await fs.promises.unlink(input).catch(() => {});
//         resolve(output);
//       })
//       .on("error", async (err) => {
//         await fs.promises.unlink(input).catch(() => {});
//         reject(err);
//       })
//       .save(output);
//   });
// };
