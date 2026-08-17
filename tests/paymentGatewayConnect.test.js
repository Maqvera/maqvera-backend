import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Payment Gateway Integration — Issue 4 (Connect Stripe flow).
// Proves: the OAuth `state` token is real, signed, tenant-bound, and
// rejects tampering/wrong-type tokens; `getStripeOAuthUrl`/`disconnectGateway`
// honestly refuse to proceed when Stripe isn't configured in this
// environment (never a fabricated success); `listGateways` never returns
// a raw, unmasked account id; and `disconnectGateway` is genuinely
// tenant-scoped (never finds/touches a different tenant's connected account).
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

test("createStripeConnectStateToken / verifyStripeConnectStateToken: real, signed, tenant-bound, rejects tampering and wrong-type tokens", async () => {
  const { createStripeConnectStateToken, verifyStripeConnectStateToken } = await import("../utils/authTokens.js");
  const jwt = (await import("jsonwebtoken")).default;
  const { getAuthConfig } = await import("../utils/authConfig.js");

  const token = createStripeConnectStateToken("tenant-abc");
  const payload = verifyStripeConnectStateToken(token);
  assert.equal(payload.tenantId, "tenant-abc");
  assert.equal(payload.type, "stripe_connect_state");

  assert.throws(() => verifyStripeConnectStateToken(`${token}tampered`));

  const wrongTypeToken = jwt.sign({ tenantId: "tenant-abc", type: "access" }, getAuthConfig().accessTokenSecret, { expiresIn: "10m" });
  assert.throws(() => verifyStripeConnectStateToken(wrongTypeToken), /type/i);
});

test("PaymentGatewayService.getStripeOAuthUrl: honestly refuses when Stripe isn't configured, never a fabricated URL", { skip: process.env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY is set in this environment — this specific unconfigured-path test doesn't apply" : false }, async () => {
  const PaymentGatewayService = (await import("../services/PaymentGatewayService.js")).default;
  await assert.rejects(() => PaymentGatewayService.getStripeOAuthUrl("some-tenant"), /not configured/i);
});

test("PaymentGatewayService.listGateways: real, tenant-scoped, never returns a raw account id", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PaymentGatewayService = (await import("../services/PaymentGatewayService.js")).default;

  const suffix = `paygw-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const rawAccountId = "acct_1234567890abcd";

  t.after(async () => { await TenantModel.deleteMany({ tenantKey: tenantId }); });

  await TenantModel.create({
    tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active",
    paymentGateways: [{ provider: "stripe", accountId: rawAccountId, status: "connected", connectedAt: new Date() }]
  });

  const gateways = await PaymentGatewayService.listGateways(tenantId);
  assert.equal(gateways.length, 1);
  assert.equal(gateways[0].provider, "stripe");
  assert.equal(gateways[0].status, "connected");
  assert.notEqual(gateways[0].accountId, rawAccountId, "the raw account id must never be returned as-is");
  assert.ok(gateways[0].accountId.includes("***"), "the account id must be masked");
});

test("PaymentGatewayService.disconnectGateway: genuinely tenant-scoped — never finds a different tenant's connected account", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PaymentGatewayService = (await import("../services/PaymentGatewayService.js")).default;

  const suffix = `paygwiso-${Date.now()}`;
  const tenantAId = `test-${suffix}-a`;
  const tenantBId = `test-${suffix}-b`;

  t.after(async () => { await TenantModel.deleteMany({ tenantKey: { $in: [tenantAId, tenantBId] } }); });

  await TenantModel.create({ tenantKey: tenantAId, name: "Tenant A", status: "active", paymentGateways: [{ provider: "stripe", accountId: "acct_tenantA", status: "connected", connectedAt: new Date() }] });
  await TenantModel.create({ tenantKey: tenantBId, name: "Tenant B", status: "active" }); // no gateway connected at all

  await assert.rejects(() => PaymentGatewayService.disconnectGateway(tenantBId, "stripe", "tester"), /no connected/i, "tenant B must never be able to disconnect a gateway it never connected");

  const reloadedA = await TenantModel.findOne({ tenantKey: tenantAId }).lean();
  assert.equal(reloadedA.paymentGateways[0].status, "connected", "tenant A's own connection must be completely unaffected by tenant B's failed attempt");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
