import { redis } from "../config/redis.js";

export const CANDIDATE_CACHE_KEY = "publicfeed:v5:candidates";

export const invalidatePublicFeedCache = async () => {
  try {
    const sharedKeys = await redis.keys("publicfeed:v3:shared:*");

    const keysToDelete = [CANDIDATE_CACHE_KEY, ...sharedKeys];

    if (keysToDelete.length > 0) {
      const deleted = await redis.del(...keysToDelete);

      console.log("[PUBLIC_FEED_CACHE_INVALIDATED]", {
        deleted,
        keys: keysToDelete.length,
      });
    }
  } catch (err) {
    console.error("Public feed cache invalidation failed:", err);
  }
};
