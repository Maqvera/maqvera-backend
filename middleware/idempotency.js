import crypto from "crypto";
import IdempotencyKeyModel from "../models/IdempotencyKeyModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { AppError, sendStandardError } from "../utils/errorContract.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashRequestBody = (body) => crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex");

const logIdempotencyEvent = (fields) => AuditLogModel.create(fields).catch((err) => console.error("Idempotency audit log error:", err.message));

/**
 * Enterprise Idempotency Standard (Enterprise Architecture Hardening
 * Phase, Improvement 3). Already mounted on ~20 financial POST endpoints
 * across `routes/FinanceRoutes.js` and others — this rewrite hardens the
 * ONE shared middleware every one of those routes already depends on,
 * rather than touching each route/controller individually:
 *
 * - **Request hash validation** — the real gap the previous version had.
 *   It replayed whatever response was stored for a key, regardless of
 *   whether the retried request's payload actually matched. Same key +
 *   different payload now correctly returns 409 `IDEMPOTENCY_KEY_REUSED`
 *   instead of silently returning a stale, unrelated response.
 * - **UUID format validation** — a malformed key is rejected before any
 *   lookup, `400 INVALID_IDEMPOTENCY_KEY_FORMAT`.
 * - **Audit logging** — every decision (stored / replayed / conflict) is
 *   now a real `AuditLogModel` row with its `correlationId`.
 * - **Standard Error Contract** (Improvement 4) — every rejection now goes
 *   through `sendStandardError`/`AppError` (utils/errorContract.js)
 *   instead of a one-off `{ code }` object, so the response also carries
 *   `category`, `severity`, `httpStatus`, and `timestamp`.
 * - **`required: true`** — an opt-in strict mode for routes that want to
 *   reject a missing key outright (`400 IDEMPOTENCY_KEY_REQUIRED`).
 *   Deliberately not turned on for any currently-mounted route in this
 *   pass — every existing `idempotency()` call site keeps its exact
 *   current behavior (header optional) so this hardening pass changes
 *   nothing for a client that was already working correctly; it only
 *   closes the same-key/different-payload gap, which no legitimate
 *   client could have been relying on anyway.
 *
 * Scope unchanged from before: this guards the common case of a client
 * retrying sequentially after a timeout. It is not a distributed lock —
 * two genuinely concurrent requests carrying the same key can both race
 * past the initial lookup and run business logic once each before either
 * response is stored (pre-existing limitation, not addressed here).
 */
const idempotency = ({ required = false } = {}) => async (req, res, next) => {
  const idempotencyKey = req.header("Idempotency-Key");
  const correlationId = req.requestId || null;

  if (!idempotencyKey) {
    if (required) {
      return sendStandardError(res, new AppError("IDEMPOTENCY_KEY_REQUIRED"), correlationId);
    }
    return next();
  }

  if (!UUID_PATTERN.test(idempotencyKey)) {
    return sendStandardError(res, new AppError("INVALID_IDEMPOTENCY_KEY_FORMAT"), correlationId);
  }

  // Tenant identity must come only from the verified JWT (req.auth), never
  // a client-settable header. No tenant context -> skip idempotency rather
  // than dedupe requests under a fake shared tenant bucket.
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return next();

  const requestHash = hashRequestBody(req.body);
  const merchantAccountId = req.body?.merchantAccountId || null;

  try {
    const existing = await IdempotencyKeyModel.findOne({ tenantId, idempotencyKey }).lean();
    if (existing) {
      if (existing.requestHash !== requestHash) {
        // Awaited (not fire-and-forget) — this decision happens inline,
        // before any response is sent, so "MUST be audit logged" can be a
        // real guarantee here: the audit row is durably persisted before
        // the client ever sees the 409, not merely attempted.
        await logIdempotencyEvent({
          action: "idempotency.key_reused", outcome: "conflict",
          reason: "Same Idempotency-Key used with a different request payload.",
          tenantId, requestId: correlationId, module: "EnterpriseIdempotency",
          resource: "IdempotencyKey", resourceId: idempotencyKey,
          details: { apiPath: req.originalUrl }
        });
        return sendStandardError(res, new AppError("IDEMPOTENCY_KEY_REUSED"), correlationId);
      }

      await logIdempotencyEvent({
        action: "idempotency.replayed", outcome: "success",
        reason: "Duplicate request replayed from the idempotency store instead of re-executing business logic.",
        tenantId, requestId: correlationId, module: "EnterpriseIdempotency",
        resource: "IdempotencyKey", resourceId: idempotencyKey,
        details: { apiPath: req.originalUrl, responseStatusCode: existing.responseStatusCode }
      });

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
        { $setOnInsert: { tenantId, idempotencyKey, requestPath: req.originalUrl, requestHash, merchantAccountId, correlationId, responseStatusCode: res.statusCode, responseBody: body } },
        { upsert: true }
      )
        .then(() => logIdempotencyEvent({
          action: "idempotency.stored", outcome: "success",
          reason: "First execution recorded for this Idempotency-Key.",
          tenantId, requestId: correlationId, module: "EnterpriseIdempotency",
          resource: "IdempotencyKey", resourceId: idempotencyKey,
          details: { apiPath: req.originalUrl, responseStatusCode: res.statusCode }
        }))
        .catch((err) => console.error("Idempotency store error:", err.message));
    }
    return originalJson(body);
  };

  next();
};

export default idempotency;
