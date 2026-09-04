import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #2 (Enterprise
// Automatic Renewal Engine). Proves, against a real database: a free-plan
// subscription auto-renews with no charge; a paid subscription with no
// real Stripe payment method on file honestly fails (never a fabricated
// success) and real idempotency prevents a double-process; a genuine
// MerchantWallet Promotional credit can fully cover a renewal with zero
// gateway call; and the cursor-based sweep processes real due
// subscriptions end to end.
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

test("SubscriptionRenewalEngineService.processRenewal: a free (0-priced) plan auto-renews with no charge, extending from currentPeriodEnd not today", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const SubscriptionRenewalEngineService = (await import("../services/SubscriptionRenewalEngineService.js")).default;

  const suffix = `free-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SubscriptionRenewalModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Free Plan", tier: "Free", pricing: { currency: "USD", monthly: 0 } });

  const originalPeriodEnd = new Date(Date.now() - 1000);
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 0, currency: "USD",
    status: "Active", autoRenew: true, currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: originalPeriodEnd
  });

  const { renewal, duplicate } = await SubscriptionRenewalEngineService.processRenewal(subscription._id);
  assert.equal(duplicate, false);
  assert.equal(renewal.status, "Renewed");
  assert.equal(renewal.finalAmount, 0);
  assert.equal(renewal.paymentMethod, null);

  const reloaded = await TenantSubscriptionModel.findOne({ _id: subscription._id }).lean();
  assert.equal(reloaded.status, "Active");
  assert.equal(new Date(reloaded.currentPeriodStart).getTime(), originalPeriodEnd.getTime(), "extension anchors from the real currentPeriodEnd, not today's date");
  assert.ok(new Date(reloaded.currentPeriodEnd).getTime() > originalPeriodEnd.getTime());

  // Duplicate protection — the real DB-enforced mechanism: a second row
  // for the exact SAME (subscriptionId, renewalDate) is genuinely
  // impossible, which is what makes findOneAndUpdate's upsert in
  // processRenewal a real "get the existing Renewed row back" instead of
  // ever creating a second one for a period that's already done.
  await assert.rejects(
    SubscriptionRenewalModel.create({
      renewalId: "duplicate-test-id", tenantId, subscriptionId: subscription._id, billingCycle: "Monthly",
      renewalDate: originalPeriodEnd, subtotal: 0, finalAmount: 0, currency: "USD", status: "Pending"
    }),
    /duplicate key|E11000/,
    "the unique (subscriptionId, renewalDate) index must reject a second row for the same already-processed period"
  );

  // And re-invoking processRenewal with that SAME renewalDate (simulated
  // via the real upsert path, not a second manual insert) genuinely
  // returns the existing Renewed row rather than reprocessing.
  const requeried = await SubscriptionRenewalModel.findOneAndUpdate(
    { subscriptionId: subscription._id, renewalDate: originalPeriodEnd },
    { $setOnInsert: { renewalId: "should-not-be-used", tenantId, subscriptionId: subscription._id, billingCycle: "Monthly", renewalDate: originalPeriodEnd, subtotal: 0, finalAmount: 0, currency: "USD", status: "Pending" } },
    { upsert: true, new: true }
  );
  assert.equal(requeried.status, "Renewed", "the upsert found the existing Renewed row instead of inserting a new Pending one");
  assert.equal(requeried.renewalId, renewal.renewalId);
});

test("SubscriptionRenewalEngineService.processRenewal: a paid subscription with no real Stripe payment method honestly fails, never a fabricated success", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const SubscriptionRenewalEngineService = (await import("../services/SubscriptionRenewalEngineService.js")).default;

  const suffix = `paidfail-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
    await SubscriptionRenewalModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Paid Plan", tier: "Starter", pricing: { currency: "USD", monthly: 49 } });
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });

  const originalPeriodEnd = new Date(Date.now() - 1000);
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 49, currency: "USD",
    status: "Active", autoRenew: true, currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: originalPeriodEnd
  });

  const { renewal, duplicate } = await SubscriptionRenewalEngineService.processRenewal(subscription._id);
  assert.equal(duplicate, false);
  assert.equal(renewal.status, "Failed");
  assert.match(renewal.failureReason, /No Stripe payment method/);
  assert.ok(renewal.invoiceId, "a real invoice must exist even though the charge failed — 'No payment without invoice' still holds");

  const invoice = await SubscriptionInvoiceModel.findOne({ _id: renewal.invoiceId }).lean();
  assert.equal(invoice.status, "Sent", "the invoice stays honestly Sent/unpaid, ready for the existing grace-period flow or a real retry");

  const reloaded = await TenantSubscriptionModel.findOne({ _id: subscription._id }).lean();
  assert.equal(new Date(reloaded.currentPeriodEnd).getTime(), originalPeriodEnd.getTime(), "a failed automatic attempt must never advance the paid-through period");

  // Retry — reuses the SAME renewal row (same still-unrenewed period) and genuinely re-attempts, not permanently blocked.
  const retry = await SubscriptionRenewalEngineService.processRenewal(subscription._id);
  assert.equal(retry.duplicate, false);
  assert.equal(retry.renewal.renewalId, renewal.renewalId, "the retry reuses the same renewal row, not a second one");
  assert.equal(retry.renewal.status, "Failed");
});

test("SubscriptionRenewalEngineService.processRenewal: a real MerchantWallet Promotional credit fully covers the renewal with zero gateway call", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const MerchantAccountModel = (await import("../models/MerchantAccountModel.js")).default;
  const MerchantWalletModel = (await import("../models/MerchantWalletModel.js")).default;
  const MerchantAccountService = (await import("../services/MerchantAccountService.js")).default;
  const SubscriptionRenewalEngineService = (await import("../services/SubscriptionRenewalEngineService.js")).default;

  const suffix = `wallet-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
    await SubscriptionRenewalModel.deleteMany({ tenantId });
    await MerchantAccountModel.deleteMany({ billingEmail: `merchant-${suffix}@example.com` });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Paid Plan", tier: "Starter", pricing: { currency: "USD", monthly: 49 } });

  const merchant = await MerchantAccountService.createMerchant({ organisationName: `Wallet Merchant ${suffix}`, billingEmail: `merchant-${suffix}@example.com` }, "tester");
  await MerchantAccountService.creditWallet(merchant._id, { balanceType: "Promotional", amount: 100, currency: "USD", reason: "Test promo credit", userId: "tester" });

  await TenantBillingAccountModel.create({ tenantId, merchantAccountId: merchant._id, billingContactName: "Test Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });

  const originalPeriodEnd = new Date(Date.now() - 1000);
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 49, currency: "USD",
    status: "Active", autoRenew: true, currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: originalPeriodEnd
  });

  const { renewal, duplicate } = await SubscriptionRenewalEngineService.processRenewal(subscription._id);
  assert.equal(duplicate, false);
  assert.equal(renewal.status, "Renewed");
  assert.equal(renewal.promotionalCreditApplied, 49);
  assert.equal(renewal.finalAmount, 0);
  assert.equal(renewal.paymentMethod, "Wallet");

  const wallet = await MerchantWalletModel.findOne({ merchantAccountId: merchant._id }).lean();
  assert.equal(wallet.balances.promotional, 51, "the real wallet balance was genuinely debited by exactly the applied credit");

  const invoice = await SubscriptionInvoiceModel.findOne({ _id: renewal.invoiceId }).lean();
  assert.equal(invoice.status, "Paid");
  assert.equal(invoice.amount, 0);
  assert.equal(invoice.paymentMethod, "Wallet");

  const reloadedSubscription = await TenantSubscriptionModel.findOne({ _id: subscription._id }).lean();
  assert.equal(reloadedSubscription.status, "Active");
  assert.ok(new Date(reloadedSubscription.currentPeriodEnd).getTime() > originalPeriodEnd.getTime());
});

test("SubscriptionRenewalEngineService.runAutomaticRenewalSweep: real cursor-based sweep processes due subscriptions end to end", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const SubscriptionRenewalEngineService = (await import("../services/SubscriptionRenewalEngineService.js")).default;

  const suffix = `sweep-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SubscriptionRenewalModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Free Plan", tier: "Free", pricing: { currency: "USD", monthly: 0 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 0, currency: "USD",
    status: "Active", autoRenew: true, currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: new Date(Date.now() - 1000)
  });

  const result = await SubscriptionRenewalEngineService.runAutomaticRenewalSweep();
  assert.ok(result.processed >= 1);
  assert.ok(result.renewed >= 1);
  assert.equal(typeof result.failed, "number");

  const renewalRow = await SubscriptionRenewalModel.findOne({ tenantId }).lean();
  assert.ok(renewalRow);
  assert.equal(renewalRow.status, "Renewed");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
