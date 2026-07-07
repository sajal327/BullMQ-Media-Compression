import dotenv from "dotenv";
dotenv.config();

import { connectDB } from "./src/config/mongo.js";
import { initRedis, redis } from "./src/config/redis.js";
import { startWorker, stopWorker } from "./src/queue/worker.js";

const start = async () => {
  try {
    await initRedis();
    await connectDB();

    await startWorker();

    console.log("Media worker started");
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
};

start();

/* ------------------ GRACEFUL SHUTDOWN ------------------ */

process.once("SIGINT", async () => {
  console.log("Shutting down...");

  try {
    await stopWorker();
    await Promise.allSettled([redis?.quit()]);
  } catch (err) {
    console.error("Shutdown error:", err);
  }

  process.exit(0);
});
