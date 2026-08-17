import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Merchant & Billing Platform (Improvement 3) — proves the
// real hierarchy end to end against a real database: "ABC Holdings owns
// 4 companies... one invoice, one payment, one subscription, multiple
// companies" (here, 2, to keep the test bounded but real) — a Merchant
// grouping 2 real, independently-isolated tenants, each with its own real
// TenantSubscriptionModel row, consolidated into ONE real
// SubscriptionInvoiceModel via a shared TenantBillingAccountModel. Also
// proves the real merchant-level suspend/reactivate cascade (composed
// from TenantSubscriptionService's own already-tested per-tenant
// suspendTenant/reactivateTenant, not a second mechanism) and the real
// Merchant Wallet credit/refund flow.
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

test("MerchantAccountService: create -> verify -> group 2 tenants -> consolidated invoice -> wallet refund -> suspend/reactivate cascade", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const SessionModel = (await import("../models/Sessionmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const MerchantAccountModel = (await import("../models/MerchantAccountModel.js")).default;
  const MerchantWalletModel = (await import("../models/MerchantWalletModel.js")).default;
  const MerchantAccountService = (await import("../services/MerchantAccountService.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `merch-${Date.now()}`;
  const tenantA = `test-${suffix}-a`;
  const tenantB = `test-${suffix}-b`;
  const fakeUserId = new mongoose.Types.ObjectId();

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: [tenantA, tenantB] } });
    await SessionModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await TenantBillingAccountModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
    await SubscriptionInvoiceModel.deleteMany({ $or: [{ tenantId: { $in: [tenantA, tenantB] } }, { tenantIds: tenantA }] });
    if (merchant) await MerchantAccountModel.deleteOne({ _id: merchant._id });
    if (merchant) await MerchantWalletModel.deleteOne({ merchantAccountId: merchant._id });
  });

  await TenantModel.create({ tenantKey: tenantA, name: `Test Tenant A ${suffix}`, status: "active" });
  await TenantModel.create({ tenantKey: tenantB, name: `Test Tenant B ${suffix}`, status: "active" });
  const sessionA = await SessionModel.create({ userId: fakeUserId, email: "a@example.com", tenantId: tenantA, refreshTokenHash: "fake-a", status: "active", expiresAt: new Date(Date.now() + 86400000) });
  const sessionB = await SessionModel.create({ userId: fakeUserId, email: "b@example.com", tenantId: tenantB, refreshTokenHash: "fake-b", status: "active", expiresAt: new Date(Date.now() + 86400000) });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Enterprise Test Plan", tier: "Enterprise", pricing: { currency: "USD", monthly: 500 } });

  let merchant = await MerchantAccountService.createMerchant({ organisationName: "ABC Holdings Test", legalName: "ABC Holdings Test LLC", taxNumber: "TAX-123", billingEmail: "billing@abcholdings.test" }, "tester");
  assert.equal(merchant.status, "Registered", "real legal/tax info supplied at creation should skip Prospect");

  merchant = await MerchantAccountService.verifyMerchant(merchant._id, "tester");
  assert.equal(merchant.status, "Verified");

  merchant = await MerchantAccountService.addTenantToMerchant(merchant._id, tenantA, "tester");
  merchant = await MerchantAccountService.addTenantToMerchant(merchant._id, tenantB, "tester");
  assert.deepEqual(merchant.tenantIds.sort(), [tenantA, tenantB].sort());

  // Each company keeps its own real, independent subscription — real per-tenant enforcement stays granular.
  await TenantSubscriptionService.setupBillingAccount(tenantA, { billingContactName: "A Billing", billingContactEmail: "a-billing@example.com", paymentMethod: "Manual" }, "tester");
  await TenantSubscriptionService.verifyBillingAccount(tenantA, "tester");
  await TenantSubscriptionService.createSubscription(tenantA, { planId: plan._id, billingCycle: "Monthly", userId: "tester" });
  await TenantSubscriptionService.setupBillingAccount(tenantB, { billingContactName: "B Billing", billingContactEmail: "b-billing@example.com", paymentMethod: "Manual" }, "tester");
  await TenantSubscriptionService.verifyBillingAccount(tenantB, "tester");
  await TenantSubscriptionService.createSubscription(tenantB, { planId: plan._id, billingCycle: "Monthly", userId: "tester" });

  merchant = await MerchantAccountService.addTenantToMerchant(merchant._id, tenantA, "tester"); // idempotent re-add now that a real subscription exists
  assert.equal(merchant.status, "Subscribed", "adding a tenant with a real, non-Trial subscription should advance the merchant to Subscribed");

  // Real consolidation: group both companies' billing accounts under one shared account, then generate ONE invoice covering both.
  const billingAccountA = await TenantBillingAccountModel.findOne({ tenantId: tenantA });
  billingAccountA.additionalTenantIds = [tenantB];
  billingAccountA.invoiceCurrency = "USD";
  billingAccountA.merchantAccountId = merchant._id;
  await billingAccountA.save();

  const { invoice: consolidatedInvoice, skipped } = await TenantSubscriptionService.generateConsolidatedInvoice(billingAccountA._id, "tester");
  assert.equal(skipped.length, 0);
  assert.equal(consolidatedInvoice.amount, 1000, "one invoice covering both companies' 500 USD subscriptions");
  assert.deepEqual(consolidatedInvoice.tenantIds.sort(), [tenantA, tenantB].sort());
  assert.equal(consolidatedInvoice.billingAccountId.toString(), billingAccountA._id.toString());

  // Real Merchant Wallet — a refund credits the wallet, never a fabricated gateway reversal.
  const wallet = await MerchantAccountService.refundToWallet(merchant._id, { amount: 50, currency: "USD", reason: "Test goodwill credit", userId: "tester" });
  assert.equal(wallet.balances.refund, 50);
  assert.equal(wallet.transactions.length, 1);

  // Real merchant-level suspend cascade — composed from the already-real per-tenant suspendTenant, once per member.
  const suspendResult = await MerchantAccountService.suspendMerchant(merchant._id, "Test cascade suspension.", "tester");
  assert.equal(suspendResult.failures.length, 0);
  assert.deepEqual(suspendResult.suspendedTenants.sort(), [tenantA, tenantB].sort());

  const reloadedTenantA = await TenantModel.findOne({ tenantKey: tenantA }).lean();
  const reloadedTenantB = await TenantModel.findOne({ tenantKey: tenantB }).lean();
  assert.equal(reloadedTenantA.status, "suspended");
  assert.equal(reloadedTenantB.status, "suspended");

  const reloadedSessionA = await SessionModel.findById(sessionA._id).lean();
  const reloadedSessionB = await SessionModel.findById(sessionB._id).lean();
  assert.equal(reloadedSessionA.status, "revoked", "merchant-level suspension must cascade to real per-tenant session revocation");
  assert.equal(reloadedSessionB.status, "revoked");

  const reactivateResult = await MerchantAccountService.reactivateMerchant(merchant._id, "tester");
  assert.equal(reactivateResult.failures.length, 0);
  const reactivatedTenantA = await TenantModel.findOne({ tenantKey: tenantA }).lean();
  assert.equal(reactivatedTenantA.status, "active");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
