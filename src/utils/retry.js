import { logger } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async (fn, options = {}) => {
  const {
    retries = 4,
    delay = 1000,
    factor = 2,
    maxDelay = 30000,

    onRetry = (err, attempt, nextDelay) => {
      logger.warn({
        event: "retry_attempt",
        attempt,
        nextDelayMs: nextDelay,
        err,
      });
    },
  } = options;

  const startedAt = Date.now();

  let attempt = 0;
  let currentDelay = delay;

  while (true) {
    try {
      const result = await fn();

      if (attempt > 0) {
        logger.info({
          event: "retry_success",
          attempts: attempt + 1,
          durationMs: Date.now() - startedAt,
        });
      }

      return result;
    } catch (err) {
      if (attempt >= retries) {
        logger.error({
          event: "retry_exhausted",
          attempts: attempt + 1,
          durationMs: Date.now() - startedAt,
          err,
        });

        throw err;
      }

      const jitter = Math.floor(Math.random() * 500);

      const waitTime = Math.min(currentDelay, maxDelay) + jitter;

      onRetry(err, attempt + 1, waitTime);

      await sleep(waitTime);

      currentDelay = Math.min(currentDelay * factor, maxDelay);

      attempt++;
    }
  }
};
