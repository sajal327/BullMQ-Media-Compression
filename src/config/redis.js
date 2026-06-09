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

// import dotenv from "dotenv";
// dotenv.config();

// import Redis from "ioredis";

// let redis, pub, redisQueue;

// const createClient = (name) => {
//   const client = new Redis({
//     host: process.env.REDIS_HOST,
//     port: Number(process.env.REDIS_PORT),
//     password: process.env.REDIS_PASSWORD,

//     maxRetriesPerRequest: null, // required for BullMQ
//     enableReadyCheck: true,

//     retryStrategy: (times) => {
//       const delay = Math.min(times * 100, 2000);
//       console.log(`🔁 Redis ${name} retrying in ${delay}ms`);
//       return delay;
//     },

//     reconnectOnError: (err) => {
//       console.error(`♻️ Redis ${name} reconnecting:`, err.message);
//       return true;
//     },

//     keepAlive: 30000,
//   });

//   client.on("connect", () => console.log(`✅ Redis ${name} connected`));

//   client.on("ready", () => console.log(`✅ Redis ${name} ready`));

//   client.on("error", (err) =>
//     console.error(`✅ Redis ${name} error:`, err.message),
//   );

//   client.on("close", () => console.warn(`⚠️ Redis ${name} connection closed`));

//   return client;
// };

// const waitForReady = (client) => {
//   return new Promise((resolve, reject) => {
//     if (client.status === "ready") return resolve();

//     client.once("ready", resolve);
//     client.once("error", reject);
//   });
// };

// export const initRedis = async () => {
//   if (redis) {
//     console.log("Redis already initialized");
//     return;
//   }

//   redis = createClient("MAIN");
//   pub = createClient("PUB");
//   redisQueue = createClient("QUEUE");

//   // DO NOT USE .connect()
//   await Promise.all([
//     waitForReady(redis),
//     waitForReady(pub),
//     waitForReady(redisQueue),
//   ]);

//   await redis.ping();
//   console.log("✅ Redis ping successful");

//   console.log("✅ All Redis clients initialized");
// };

// export { redis, pub, redisQueue };

// import Redis from "ioredis";

// let redis, pub, sub, redisQueue;

// export const initRedis = async () => {
//   const redisOptions = {
//     host: process.env.REDIS_HOST,
//     port: Number(process.env.REDIS_PORT),
//     password: process.env.REDIS_PASSWORD,
//     maxRetriesPerRequest: null,
//     enableReadyCheck: true,
//   };

//   redis = new Redis(redisOptions);
//   pub = new Redis(redisOptions);
//   sub = new Redis(redisOptions);
//   redisQueue = new Redis(redisOptions);

//   const clients = [
//     { name: "MAIN", client: redis },
//     { name: "PUB", client: pub },
//     { name: "SUB", client: sub },
//     { name: "QUEUE", client: redisQueue },
//   ];

//   // Attach logs
//   clients.forEach(({ name, client }) => {
//     client.on("connect", () => console.log(`✅ Redis ${name} connected`));
//     client.on("error", (err) =>
//       console.error(`❌ Redis ${name} error:`, err.message || err),
//     );
//   });

//   // WAIT for all clients to be ready
//   await Promise.all(
//     clients.map(
//       ({ client }) =>
//         new Promise((resolve, reject) => {
//           client.once("ready", resolve);
//           client.once("error", reject);
//         }),
//     ),
//   );

//   console.log("All Redis clients ready");
// };

// export { redis, pub, sub, redisQueue };

// import Redis from "ioredis";

// const redisOptions = {
//   host: process.env.REDIS_HOST,
//   port: process.env.REDIS_PORT,
//   password: process.env.REDIS_PASSWORD,

//   maxRetriesPerRequest: null,
//   enableReadyCheck: true,
//   connectTimeout: 10000,

//   retryStrategy(times) {
//     return Math.min(times * 200, 2000);
//   },
// };

// // Connections
// export const redis = new Redis(redisOptions);
// export const pub = new Redis(redisOptions);
// export const sub = new Redis(redisOptions);
// export const redisQueue = new Redis(redisOptions);

// // Better logging
// [redis, pub, sub, redisQueue].forEach((client, i) => {
//   client.on("error", (err) => {
//     console.error(`Redis Client ${i} error:`, err);
//   });
// });
