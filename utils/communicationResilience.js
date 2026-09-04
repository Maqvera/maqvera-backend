import { executeResilientOperation, moveToDeadLetterQueue } from "./resilienceEngine.js";
import { getResilienceConfig } from "./resilienceConfig.js";

/**
 * Retry & DLQ for the Communication Platform (Part 11), reusing the SAME
 * generic resilience engine every other integration in this codebase goes
 * through — never a second, parallel retry/circuit-breaker/DLQ system.
 * `resilienceConfig.js` already carries pre-tuned `Email`/`SMS` integration
 * entries (`DEFAULT_INTEGRATIONS`) that were, per `resilienceEngine.js`'s own
 * comment, deliberately left unwired until a module adopted them — this is
 * that adoption.
 *
 * Delivery adapters (`services/delivery/*.js`) don't throw on failure, they
 * resolve `{ status: "Failed"|"NotConfigured", failureReason }` with a free-text
 * reason (no structured HTTP status) — so classification here is pattern-based
 * against that text, mirroring resilienceConfig's own status-code tables where
 * a status code IS present in the message (e.g. "HTTP 503").
 */

const PERMANENT_FAILURE_PATTERNS = [
  /not configured/,
  /no (email address|phone number|device token) available/,
  /invalid (email|phone|recipient)/,
  /no such (user|recipient|mailbox)/,
  /does not exist/,
  /unsubscribed/,
  /blacklisted/,
  /malformed/,
  // FCM's own wording for a dead/rotated push token — retrying can never
  // succeed, matches the doc's own "550 Invalid Email Address" example.
  /registration-token-not-registered|invalid-registration-token/
];

const TEMPORARY_FAILURE_PATTERNS = [
  /timeout|timed out/,
  /rate limit|too many requests/,
  /temporarily unavailable/,
  /service unavailable/,
  /econnreset|etimedout|enotfound|eai_again|econnaborted/
];

/**
 * Same spirit as `resilienceConfig.js`'s own `isRetryableError`, adapted for
 * error text instead of structured status: HTTP 5xx / provider-timeout /
 * rate-limit shaped failures are retryable; invalid-recipient / not-configured
 * / bounced-permanently shaped failures are not. Unclassified text is treated
 * as non-retryable — the same safe default the shared config already commits to.
 */
export const isRetryableCommunicationFailure = (error) => {
  const config = getResilienceConfig();
  const message = String(error?.message || "").toLowerCase();

  const statusMatch = message.match(/\b([45]\d{2})\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (config.nonRetryableHttpStatusCodes.includes(status)) return false;
    if (config.retryableHttpStatusCodes.includes(status)) return true;
  }

  if (error?.name === "AbortError") return true;
  if (error?.code && config.retryableNetworkErrorCodes.includes(error.code)) return true;

  if (PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return false;
  if (TEMPORARY_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return true;

  return false;
};

/**
 * Runs one channel-send attempt (`run`) through the shared resilience engine
 * — retry-with-backoff + circuit breaker — and guarantees the message lands
 * in the shared Dead Letter Queue on final failure, whether that's because
 * retries were exhausted (resilienceEngine already DLQs that case itself) or
 * because the failure was classified permanent up front (thrown immediately,
 * never DLQ'd by resilienceEngine's own generic contract — queued here
 * instead, since a communication send has no synchronous caller waiting to
 * handle it as a normal business error the way a request-time API call would).
 * Never silently drops a failed send.
 */
export const dispatchCommunicationWithResilience = async ({ channel, tenantId, messageId, sourceModule = null, idempotencyKey = null, recipient = {}, run }) => {
  const payload = { messageId, channel, sourceModule, recipient };

  try {
    return await executeResilientOperation({
      integration: channel,
      module: "Communication",
      operationLabel: `${channel}Send`,
      tenantId,
      correlationId: messageId,
      idempotencyKey,
      payload,
      isRetryable: isRetryableCommunicationFailure,
      run
    });
  } catch (err) {
    if (err.details?.dlqId) {
      err.dlqId = err.details.dlqId;
      throw err;
    }

    const dlq = await moveToDeadLetterQueue({
      integration: channel,
      module: "Communication",
      operationLabel: `${channel}Send`,
      tenantId,
      correlationId: messageId,
      idempotencyKey,
      payload,
      attemptsMade: 1,
      reason: err.message
    });
    err.dlqId = dlq._id;
    throw err;
  }
};
