import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import idempotency from "../middleware/idempotency.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Idempotency Standard
// (Improvement 3). Real end-to-end proof against a live database: the
// exact "customer clicks Pay Invoice twice" scenario the standard exists
// to prevent, PLUS the request-hash gap the pre-existing middleware had
// (same key + different payload used to silently replay a stale,
// unrelated response instead of rejecting it).
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const makeRes = () => ({
  statusCode: null,
  body: null,
  headers: {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader(name, value) { this.headers[name] = value; }
});

const makeReq = ({ tenantId, key, body, requestId = "corr-1" }) => ({
  header(name) { return name === "Idempotency-Key" ? key : null; },
  headers: {},
  body,
  auth: tenantId ? { tenantId } : undefined,
  requestId,
  originalUrl: "/api/v1/payments"
});

test("idempotency middleware: real duplicate-payment prevention, hash-mismatch conflict, audit trail", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const IdempotencyKeyModel = (await import("../models/IdempotencyKeyModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const tenantId = `test-idem-${Date.now()}`;
  const key = "6b98cb82-4c9d-4e34-8b5f-12562f0d75ae";

  t.after(async () => {
    await IdempotencyKeyModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  // First request: "Pay Invoice, amount 1000" — no record yet, business logic runs.
  const req1 = makeReq({ tenantId, key, body: { amount: 1000 } });
  const res1 = makeRes();
  let handlerRan = false;
  await idempotency()(req1, res1, () => { handlerRan = true; });
  assert.equal(handlerRan, true, "a fresh key must let the real handler run");

  // The real handler now responds — this is what actually gets recorded.
  res1.status(201).json({ success: true, message: "Payment captured.", data: { paymentId: "PAY-1", amount: 1000 } });

  // Give the fire-and-forget store a moment to land (same discipline as
  // every other async-side-effect test in this codebase).
  await new Promise((resolve) => setTimeout(resolve, 150));

  const stored = await IdempotencyKeyModel.findOne({ tenantId, idempotencyKey: key }).lean();
  assert.ok(stored, "the first successful response must be persisted");
  assert.equal(stored.responseStatusCode, 201);
  assert.equal(stored.responseBody.data.paymentId, "PAY-1");

  // Customer's "Internet disconnects" retry — SAME key, SAME payload.
  const req2 = makeReq({ tenantId, key, body: { amount: 1000 } });
  const res2 = makeRes();
  let handlerRanAgain = false;
  await idempotency()(req2, res2, () => { handlerRanAgain = true; });

  assert.equal(handlerRanAgain, false, "business logic must NOT re-execute for an identical retried request — this is the actual duplicate-payment prevention");
  assert.equal(res2.statusCode, 201, "the ORIGINAL response must be replayed verbatim");
  assert.equal(res2.body.data.paymentId, "PAY-1");
  assert.equal(res2.headers["Idempotency-Replayed"], "true");

  // A genuinely different request that happens to reuse the same key —
  // the enterprise rule this middleware previously did NOT enforce.
  const req3 = makeReq({ tenantId, key, body: { amount: 5000 } });
  const res3 = makeRes();
  let handlerRanThird = false;
  await idempotency()(req3, res3, () => { handlerRanThird = true; });

  assert.equal(handlerRanThird, false);
  assert.equal(res3.statusCode, 409);
  assert.equal(res3.body.data.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(res3.body.data.correlationId, "corr-1");

  // "Every idempotency decision MUST be recorded in the audit log."
  const auditActions = (await AuditLogModel.find({ tenantId, resourceId: key }).sort({ createdAt: 1 }).lean()).map((a) => a.action);
  assert.deepEqual(auditActions, ["idempotency.stored", "idempotency.replayed", "idempotency.key_reused"]);
});

test("idempotency middleware: format validation, required mode, and no-tenant-context skip", { skip: !dbAvailable && dbSkipReason }, async () => {
  const tenantId = `test-idem-fmt-${Date.now()}`;

  const malformedReq = makeReq({ tenantId, key: "not-a-real-uuid", body: {} });
  const malformedRes = makeRes();
  let ran = false;
  await idempotency()(malformedReq, malformedRes, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(malformedRes.statusCode, 400);
  assert.equal(malformedRes.body.data.code, "INVALID_IDEMPOTENCY_KEY_FORMAT");

  const missingReqStrict = makeReq({ tenantId, key: null, body: {} });
  const missingResStrict = makeRes();
  let ranStrict = false;
  await idempotency({ required: true })(missingReqStrict, missingResStrict, () => { ranStrict = true; });
  assert.equal(ranStrict, false);
  assert.equal(missingResStrict.statusCode, 400);
  assert.equal(missingResStrict.body.data.code, "IDEMPOTENCY_KEY_REQUIRED");

  const missingReqDefault = makeReq({ tenantId, key: null, body: {} });
  const missingResDefault = makeRes();
  let ranDefault = false;
  await idempotency()(missingReqDefault, missingResDefault, () => { ranDefault = true; });
  assert.equal(ranDefault, true, "a missing key must stay opt-in (next() called) unless required: true is explicitly set — no existing route's behavior changes");

  const noTenantReq = { ...makeReq({ tenantId, key: "6b98cb82-4c9d-4e34-8b5f-12562f0d75ae", body: {} }), auth: undefined };
  const noTenantRes = makeRes();
  let ranNoTenant = false;
  await idempotency()(noTenantReq, noTenantRes, () => { ranNoTenant = true; });
  assert.equal(ranNoTenant, true, "no authenticated tenant -> skip idempotency entirely rather than dedupe under a fake shared bucket");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
