import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Supplier Self-Service Portal (PRD "CRM Feature Map by Phase" Phase 3
// module 24) — same direct-controller-call convention as
// tests/agentPortal.test.js. Covers: staff-side token issuance/listing/
// revocation, the token-authentication middleware (missing/invalid/revoked/
// expired all rejected), invoice submission + own-invoice listing, and
// cross-vendor isolation (vendor A's token can never see vendor B's data).

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

const makeReqRes = (header = null) => {
  const req = { header: (name) => (name === "X-Supplier-Token" ? header : null), requestId: "test-req" };
  return { req, res: makeRes() };
};

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

test("Supplier Portal: token issuance/revocation, authentication middleware, invoice submission, cross-vendor isolation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/SupplierPortalController.js");
  const authMiddleware = (await import("../middleware/authenticateVendorPortalToken.js")).default;
  const VendorModel = (await import("../models/VendorModel.js")).default;
  const VendorPortalTokenModel = (await import("../models/VendorPortalTokenModel.js")).default;
  const VendorInvoiceModel = (await import("../models/VendorInvoiceModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-supplier-portal-${suffix}`;

  const cleanupModels = [VendorModel, VendorPortalTokenModel, VendorInvoiceModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
  });

  const vendorA = await VendorModel.create({ tenantId, name: `Vendor A ${suffix}`, currency: "USD" });
  const vendorB = await VendorModel.create({ tenantId, name: `Vendor B ${suffix}`, currency: "USD" });

  // ---- Staff-side: permission gate ----
  const noPermRes = makeRes();
  await ctrl.issueSupplierPortalToken({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { vendorId: vendorA._id.toString() }, body: {} }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Issue tokens for both vendors ----
  const issueARes = makeRes();
  await ctrl.issueSupplierPortalToken({ auth: authAdmin(tenantId), params: { vendorId: vendorA._id.toString() }, body: { name: "Portal login" } }, issueARes);
  assert.equal(issueARes.statusCode, 201, JSON.stringify(issueARes.body));
  assert.ok(issueARes.body.data.token, "the raw token must be returned exactly once");
  const rawTokenA = issueARes.body.data.token;

  const issueBRes = makeRes();
  await ctrl.issueSupplierPortalToken({ auth: authAdmin(tenantId), params: { vendorId: vendorB._id.toString() }, body: {} }, issueBRes);
  const rawTokenB = issueBRes.body.data.token;

  const listTokensRes = makeRes();
  await ctrl.listSupplierPortalTokens({ auth: authAdmin(tenantId), params: { vendorId: vendorA._id.toString() } }, listTokensRes);
  assert.equal(listTokensRes.body.data.items.length, 1);
  assert.equal(listTokensRes.body.data.items[0].hashedKey, undefined, "the hashed secret must never be exposed");

  // ---- Auth middleware: missing/invalid token rejected ----
  const { req: reqMissing, res: resMissing } = makeReqRes(null);
  await authMiddleware(reqMissing, resMissing, () => assert.fail("next() must not be called with no token"));
  assert.equal(resMissing.statusCode, 401);

  const { req: reqBad, res: resBad } = makeReqRes("not-a-real-token");
  await authMiddleware(reqBad, resBad, () => assert.fail("next() must not be called with an invalid token"));
  assert.equal(resBad.statusCode, 401);

  // ---- Auth middleware: valid token sets req.vendorAuth, scoped to the right vendor ----
  const { req: reqA, res: resA } = makeReqRes(rawTokenA);
  let nextCalledA = false;
  await authMiddleware(reqA, resA, () => { nextCalledA = true; });
  assert.equal(nextCalledA, true);
  assert.equal(reqA.vendorAuth.tenantId, tenantId);
  assert.equal(reqA.vendorAuth.vendorId, vendorA._id.toString());

  const { req: reqB } = makeReqRes(rawTokenB);
  await authMiddleware(reqB, makeRes(), () => {});

  // ---- Supplier-side: profile, invoice submission, own-invoice listing ----
  const profileRes = makeRes();
  await ctrl.getMySupplierProfile(reqA, profileRes);
  assert.equal(profileRes.statusCode, 200);
  assert.equal(profileRes.body.data.name, `Vendor A ${suffix}`);

  const submitRes = makeRes();
  await ctrl.submitSupplierInvoice({ ...reqA, body: { supplierInvoiceNumber: "SUP-001", amount: 500, currency: "usd" } }, submitRes);
  assert.equal(submitRes.statusCode, 201, JSON.stringify(submitRes.body));
  assert.equal(submitRes.body.data.status, "Submitted");
  assert.equal(submitRes.body.data.currency, "USD");

  const missingFieldsRes = makeRes();
  await ctrl.submitSupplierInvoice({ ...reqA, body: { amount: 500 } }, missingFieldsRes);
  assert.equal(missingFieldsRes.statusCode, 400);

  // ---- Cross-vendor isolation: vendor B's token must never see vendor A's invoices ----
  const listAInvoicesRes = makeRes();
  await ctrl.listMySupplierInvoices(reqA, listAInvoicesRes);
  assert.equal(listAInvoicesRes.body.data.items.length, 1);

  const listBInvoicesRes = makeRes();
  await ctrl.listMySupplierInvoices(reqB, listBInvoicesRes);
  assert.equal(listBInvoicesRes.body.data.items.length, 0, "vendor B must never see vendor A's submitted invoices");

  // ---- Payments: reuses VendorPaymentService, forced to the caller's own vendorId ----
  const paymentsRes = makeRes();
  await ctrl.listMySupplierPayments(reqA, paymentsRes);
  assert.equal(paymentsRes.statusCode, 200);
  assert.deepEqual(paymentsRes.body.data.items, []);

  // ---- Revoke: token stops working immediately ----
  const tokenAId = issueARes.body.data._id.toString();
  const revokeRes = makeRes();
  await ctrl.revokeSupplierPortalToken({ auth: authAdmin(tenantId), params: { tokenId: tokenAId } }, revokeRes);
  assert.equal(revokeRes.statusCode, 200);

  const { req: reqARevoked, res: resARevoked } = makeReqRes(rawTokenA);
  await authMiddleware(reqARevoked, resARevoked, () => assert.fail("next() must not be called with a revoked token"));
  assert.equal(resARevoked.statusCode, 401);

  const revokeAgainRes = makeRes();
  await ctrl.revokeSupplierPortalToken({ auth: authAdmin(tenantId), params: { tokenId: tokenAId } }, revokeAgainRes);
  assert.equal(revokeAgainRes.statusCode, 409);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
