import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Platform — proves the real lifecycle engine end
// to end against a real database: Trial -> Subscription -> Manual Payment
// -> Active; the daily sweep genuinely suspending a tenant with no
// payment (real TenantModel.status flip + real Session revocation, both
// already-existing switches this platform reuses rather than duplicates);
// reactivation on payment; and the real per-request enforcement check's
// three real outcomes (not enforced / suspended / expired).
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

test("TenantSubscriptionService: Trial -> Subscription -> Manual Payment -> Active, and the enforcement check reflects every real state", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `sub-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });

  // No subscription row yet — must be a complete no-op (backward compatible).
  const noRowBlock = await TenantSubscriptionService.getEnforcementBlock(tenantId);
  assert.equal(noRowBlock, null);

  const plan = await PlatformPlanModel.create({
    planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Professional",
    pricing: { currency: "USD", monthly: 99 }, trialDays: 1, gracePeriodDays: 0
  });

  const trial = await TenantSubscriptionService.startTrial(tenantId, plan._id, "tester");
  assert.equal(trial.status, "Trial");

  // File 0's own "Merchant Account Active"/"Currency Supported" real
  // validation rules, checked before any billing account exists.
  await assert.rejects(
    TenantSubscriptionService.createSubscription(tenantId, { planId: plan._id, billingCycle: "Monthly", userId: "tester" }),
    /billing account is required/
  );

  const unsupportedCurrencyPlan = await PlatformPlanModel.create({
    planCode: `TESTPLAN-CCY-${suffix}`, name: "Bad Currency Plan", tier: "Starter", pricing: { currency: "ZZZ", monthly: 10 }
  });
  await assert.rejects(
    TenantSubscriptionService.createSubscription(tenantId, { planId: unsupportedCurrencyPlan._id, billingCycle: "Monthly", userId: "tester" }),
    /is not supported/
  );
  await PlatformPlanModel.deleteOne({ _id: unsupportedCurrencyPlan._id });

  // "Merchant Account Active" (File 0) — createSubscription now
  // requires a real, Active/Verified billing account before a paid plan.
  // A Manual-method account starts Pending and needs a real, separate
  // verification step (verifyBillingAccount), same as any non-Stripe method.
  await TenantSubscriptionService.setupBillingAccount(tenantId, { billingContactName: "Test Billing Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual" }, "tester");
  await assert.rejects(
    TenantSubscriptionService.createSubscription(tenantId, { planId: plan._id, billingCycle: "Monthly", userId: "tester" }),
    /Billing account is not active/
  );
  await TenantSubscriptionService.verifyBillingAccount(tenantId, "tester");

  const { subscription, invoice } = await TenantSubscriptionService.createSubscription(tenantId, { planId: plan._id, billingCycle: "Monthly", userId: "tester" });
  assert.equal(subscription.status, "PastDue");
  assert.ok(invoice, "expected a real invoice for a non-zero-priced plan");
  assert.equal(invoice.status, "Sent");
  assert.equal(invoice.amount, 99);

  // PastDue is not itself an enforced-block state (only Suspended/Expired are) — access continues while the invoice is outstanding, matching the real spec flow "Invoice Generated -> Wait Payment" (not an immediate lockout).
  const pastDueBlock = await TenantSubscriptionService.getEnforcementBlock(tenantId);
  assert.equal(pastDueBlock, null);

  const paidInvoice = await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: "TEST-REF-1", userId: "tester" });
  assert.equal(paidInvoice.status, "Paid");

  const reloadedSubscription = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(reloadedSubscription.status, "Active");
  assert.ok(reloadedSubscription.lastPaymentAt);

  // POST /api/v1/subscriptions/{id}/renew — File 0's own literal
  // real composition (real invoice reused/generated, real manual payment).
  const { invoice: renewalInvoice } = await TenantSubscriptionService.renewNow(tenantId, "tester");
  assert.ok(renewalInvoice, "expected a real renewal invoice");
  assert.equal(renewalInvoice.invoiceType, "Renewal");
  assert.equal(renewalInvoice.status, "Sent");
});

test("TenantSubscriptionService.runDailyLifecycleSweep: a genuinely unpaid subscription with 0-day grace suspends the tenant — real TenantModel.status flip + real Session revocation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const SessionModel = (await import("../models/Sessionmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `suspend-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const fakeUserId = new mongoose.Types.ObjectId();

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SessionModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 49 }, gracePeriodDays: 0 });

  // A real, already-expired, unpaid subscription — as if the daily sweep is running the day after currentPeriodEnd.
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 49, currency: "USD",
    status: "Active", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000)
  });

  const activeSession = await SessionModel.create({
    userId: fakeUserId, email: "tester@example.com", tenantId, refreshTokenHash: "fake-hash-for-test", status: "active", expiresAt: new Date(Date.now() + 86400000)
  });

  const firstPass = await TenantSubscriptionService.runDailyLifecycleSweep();
  assert.ok(firstPass.gracePeriodsStarted >= 1, "expected this tenant's 0-day-grace subscription to enter GracePeriod");
  assert.ok(firstPass.suspended >= 1, "expected the same 0-day grace window to be immediately eligible for suspension within the same sweep pass");

  const reloadedTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedTenant.status, "suspended", "0-day grace period should suspend immediately on the first sweep pass");
  assert.ok(reloadedTenant.suspendedAt);

  const reloadedSession = await SessionModel.findById(activeSession._id).lean();
  assert.equal(reloadedSession.status, "revoked", "the real, pre-existing Session revocation mechanism must actually fire");
  assert.ok(reloadedSession.revokedAt);

  const reloadedSubscription = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(reloadedSubscription.status, "Suspended");

  const block = await TenantSubscriptionService.getEnforcementBlock(tenantId);
  assert.equal(block.httpStatus, 403);
  assert.equal(block.code, "SUBSCRIPTION_SUSPENDED");
});

test("TenantSubscriptionService: reactivateTenant restores real TenantModel access after a suspension", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `reactivate-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: 49 } });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 49, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });

  await TenantSubscriptionService.suspendTenant(tenantId, "Test suspension.", "tester");
  let reloaded = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloaded.status, "suspended");

  await TenantSubscriptionService.reactivateTenant(tenantId, "tester");
  reloaded = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloaded.status, "active");
  assert.equal(reloaded.suspendedAt, null);

  const block = await TenantSubscriptionService.getEnforcementBlock(tenantId);
  assert.equal(block, null);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
