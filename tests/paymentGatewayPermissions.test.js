import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Payment Gateway Integration — Issue 9 (permission gate).
// Proves: the real `payments.connect`/`payments.disconnect`/`payments.view`
// permission keys exist in the real seeded catalog, `ensureAdministratorRole`
// genuinely includes them (Administrator/owner gets access), a freshly
// auto-provisioned non-admin role (`ensureTenantRole`) genuinely does NOT
// (no accidental broad grant), and — the PRD's own acceptance criterion —
// a non-admin tenant user genuinely gets 403 on the real controller
// action, never silently allowed through.
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

test("DEFAULT_PERMISSIONS: the real payments.connect/disconnect/view keys exist in the seeded catalog", async () => {
  const { DEFAULT_PERMISSIONS } = await import("../utils/authDomainDefaults.js");
  const keys = DEFAULT_PERMISSIONS.map((p) => p.key);
  assert.ok(keys.includes("payments.connect"));
  assert.ok(keys.includes("payments.disconnect"));
  assert.ok(keys.includes("payments.view"));
});

test("ensureAdministratorRole includes the new payments.* keys; ensureTenantRole for an arbitrary role name genuinely does NOT (no accidental privilege escalation)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const RoleModel = (await import("../models/Rolemodel.js")).default;
  const { ensureAdministratorRole, ensureTenantRole } = await import("../utils/authDomainDefaults.js");

  const suffix = `paypermrole-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => { await RoleModel.deleteMany({ tenantId }); });

  const adminRole = await ensureAdministratorRole(tenantId);
  assert.ok(adminRole.permissions.includes("payments.connect"));
  assert.ok(adminRole.permissions.includes("payments.disconnect"));
  assert.ok(adminRole.permissions.includes("payments.view"));

  const staffRole = await ensureTenantRole(tenantId, "Sales Agent");
  assert.equal(staffRole.permissions.length, 0, "an arbitrary auto-provisioned role must start with zero permissions, never inherit payments.* or any other access implicitly");
});

test("DisconnectGateway: a non-admin tenant user genuinely gets 403, never silently allowed through", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { DisconnectGateway } = await import("../controllers/PaymentGatewayController.js");

  const req = { auth: { tenantId: "some-tenant", userId: "tester", permissions: ["booking.read"] }, body: { provider: "stripe" }, requestId: "test-req-id" };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; }
  };

  await DisconnectGateway(req, res);
  assert.equal(statusCode, 403);
  assert.equal(payload.success, false);
});

test("GetConnectUrl / ListGateways: also genuinely 403 without the real payments.connect / payments.view permission", async () => {
  const { GetConnectUrl, ListGateways } = await import("../controllers/PaymentGatewayController.js");

  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };

  const reqNoPerms = { auth: { tenantId: "some-tenant", userId: "tester", permissions: [] }, requestId: "test-req-id" };

  const res1 = makeRes();
  await GetConnectUrl(reqNoPerms, res1);
  assert.equal(res1.statusCode, 403);

  const res2 = makeRes();
  await ListGateways(reqNoPerms, res2);
  assert.equal(res2.statusCode, 403);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
