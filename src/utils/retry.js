export const retry = async (fn, options = {}) => {
  const { retries = 5, delay = 500, factor = 2, onRetry = () => {} } = options;

  let attempt = 0;
  let currentDelay = delay;

  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      if (attempt >= retries) {
        throw err;
      }

      onRetry(err, attempt);

      await new Promise((res) => setTimeout(res, currentDelay));
      currentDelay *= factor;
    }
  }
};
