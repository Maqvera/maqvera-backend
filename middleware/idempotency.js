import IdempotencyKeyModel from "../models/IdempotencyKeyModel.js";

/**
 * Opt-in idempotency for write endpoints. A client that sends an
 * `Idempotency-Key` header gets back the exact same response if it retries
 * with the same key (e.g. after a timeout where it can't tell whether the
 * first attempt succeeded) — instead of the business logic running again
 * and, for a Create endpoint, producing a duplicate record.
 *
 * No header present -> the endpoint behaves exactly as before (opt-in, not
 * a breaking change to existing callers).
 *
 * Scope: this guards the common case of a client retrying sequentially
 * after a timeout. It is not a distributed lock — two genuinely concurrent
 * requests carrying the same key can both race past the initial lookup and
 * run business logic once each before either response is stored.
 */
const idempotency = () => async (req, res, next) => {
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey) return next();

  // Tenant identity must come only from the verified JWT (req.auth), never
  // a client-settable header. No tenant context -> skip idempotency rather
  // than dedupe requests under a fake shared tenant bucket.
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return next();

  try {
    const existing = await IdempotencyKeyModel.findOne({ tenantId, idempotencyKey }).lean();
    if (existing) {
      res.setHeader("Idempotency-Replayed", "true");
      return res.status(existing.responseStatusCode).json(existing.responseBody);
    }
  } catch (err) {
    console.error("Idempotency lookup error:", err.message);
    // Fail open — an idempotency-store hiccup shouldn't block the request.
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      IdempotencyKeyModel.findOneAndUpdate(
        { tenantId, idempotencyKey },
        { $setOnInsert: { tenantId, idempotencyKey, requestPath: req.originalUrl, responseStatusCode: res.statusCode, responseBody: body } },
        { upsert: true }
      ).catch((err) => console.error("Idempotency store error:", err.message));
    }
    return originalJson(body);
  };

  next();
};

export default idempotency;
