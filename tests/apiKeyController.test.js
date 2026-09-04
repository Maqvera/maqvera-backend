import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Controller-level coverage for the Developer Portal's API key issuance
// (PRD "CRM Feature Map by Phase" Phase 4 module 33) — same direct-
// controller-call convention as tests/leadController.test.js.

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
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });
const authScoped = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: ["apikey.manage", "customer.read"] });
const authNoPerm = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: [] });

test("API Key controller: issuance never re-exposes the raw key, permission escalation blocked, revoke lifecycle, tenant scope", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/ApiKeyController.js");
  const ApiKeyModel = (await import("../models/ApiKeyModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-apikey-${suffix}`;

  t.after(async () => {
    await ApiKeyModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  // ---- Permission gates ----
  const noPermRes = makeRes();
  await ctrl.createApiKey({ auth: authNoPerm(tenantId), body: { name: "x" } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Cannot grant a permission the caller doesn't hold ----
  const escalateRes = makeRes();
  await ctrl.createApiKey({ auth: authScoped(tenantId), body: { name: "Scoped key", permissions: ["customer.read", "admin"] } }, escalateRes);
  assert.equal(escalateRes.statusCode, 400, JSON.stringify(escalateRes.body));

  // ---- Happy path: raw key returned exactly once, never persisted in plaintext ----
  const createRes = makeRes();
  await ctrl.createApiKey({ auth: authScoped(tenantId), body: { name: "Scoped key", permissions: ["customer.read"] } }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  assert.ok(createRes.body.data.key.startsWith("mvk_"), "raw key must be returned on creation");
  assert.equal(createRes.body.data.hashedKey, undefined, "the hash must never be exposed in the response");
  assert.deepEqual(createRes.body.data.permissions, ["customer.read"]);
  const apiKeyId = createRes.body.data._id.toString();

  const stored = await ApiKeyModel.findById(apiKeyId).lean();
  assert.notEqual(stored.hashedKey, createRes.body.data.key, "the stored value must be a hash, never the raw key");
  assert.equal(stored.status, "Active");

  // ---- List: hash never leaks, key never leaks ----
  const listRes = makeRes();
  await ctrl.listApiKeys({ auth: authAdmin(tenantId) }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 1);
  assert.equal(listRes.body.data.items[0].hashedKey, undefined);
  assert.equal(listRes.body.data.items[0].key, undefined);
  assert.ok(listRes.body.data.items[0].keyPrefix.startsWith("mvk_"));

  // ---- Revoke: gated, idempotent-safe (double revoke -> 409), reflected in list ----
  const revokeNoPermRes = makeRes();
  await ctrl.revokeApiKey({ auth: authNoPerm(tenantId), params: { apiKeyId } }, revokeNoPermRes);
  assert.equal(revokeNoPermRes.statusCode, 403);

  const revokeRes = makeRes();
  await ctrl.revokeApiKey({ auth: authAdmin(tenantId), params: { apiKeyId } }, revokeRes);
  assert.equal(revokeRes.statusCode, 200, JSON.stringify(revokeRes.body));
  assert.equal(revokeRes.body.data.status, "Revoked");

  const doubleRevokeRes = makeRes();
  await ctrl.revokeApiKey({ auth: authAdmin(tenantId), params: { apiKeyId } }, doubleRevokeRes);
  assert.equal(doubleRevokeRes.statusCode, 409);

  // ---- Tenant isolation: a different tenant sees no keys ----
  const otherTenantListRes = makeRes();
  await ctrl.listApiKeys({ auth: authAdmin(`${tenantId}-other`) }, otherTenantListRes);
  assert.equal(otherTenantListRes.statusCode, 200);
  assert.equal(otherTenantListRes.body.data.items.length, 0);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
