const DEFAULT_MAX_ATTEMPTS = Number.parseInt(process.env.RETRY_MAX_ATTEMPTS || "3", 10) || 3;
const DEFAULT_BASE_DELAY_MS = Number.parseInt(process.env.RETRY_BASE_DELAY_MS || "300", 10) || 300;

/**
 * Retries a transient external-service call with exponential backoff.
 * Reserved for real network calls (object storage, external APIs) — never
 * wrap a local/DB operation in this, since retrying a non-idempotent write
 * on a false-negative timeout can duplicate it.
 */
export const retryWithBackoff = async (fn, { maxAttempts = DEFAULT_MAX_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, label = "operation" } = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message}. Retrying in ${delayMs}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
};

export default retryWithBackoff;
