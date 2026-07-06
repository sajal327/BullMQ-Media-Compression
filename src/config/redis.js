import dotenv from "dotenv";
dotenv.config();

import Redis from "ioredis";

/* ------------------ BASE CONFIG ------------------ */

const baseConfig = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,

  maxRetriesPerRequest: null,
  enableReadyCheck: true,

  connectTimeout: 15000,
  keepAlive: 30000,

  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    console.log(`🔁 Redis retry in ${delay}ms`);
    return delay;
  },

  reconnectOnError(err) {
    if (
      err.message.includes("ETIMEDOUT") ||
      err.message.includes("ECONNRESET")
    ) {
      console.log("♻️ Reconnecting Redis:", err.message);
      return true;
    }
    return false;
  },
};

/* ------------------ SINGLE CLIENT (CACHE ONLY) ------------------ */

let redis;

export const initRedis = async () => {
  if (redis) {
    console.log("Redis already initialized");
    return;
  }

  redis = new Redis(baseConfig);

  redis.on("connect", () => console.log("✅ Redis connected"));
  redis.on("ready", () => console.log("✅ Redis ready"));
  redis.on("error", (err) => console.error("❌ Redis error:", err.message));
  redis.on("close", () => console.warn("⚠️ Redis connection closed"));

  await new Promise((resolve, reject) => {
    redis.once("ready", resolve);
    redis.once("error", reject);
  });

  await redis.ping();
  console.log("✅ Redis ping successful");
};

export { redis };

/* ------------------ BULLMQ CONNECTION CONFIG ------------------ */

export const redisQueueConfig = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
};
