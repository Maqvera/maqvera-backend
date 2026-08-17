import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #4 (Enterprise
// Grace Period Engine). Proves, against a real database: grace starts
// with the real per-plan day count and a real explicit graceStartedAt;
// the primary trigger is genuinely event-driven (a renewal's terminal
// failure puts the subscription into GracePeriod immediately, not on the
// next daily sweep); a real payment received during grace immediately
// restores Active and records graceEndedAt; the daily-sweep safety net
// skips a subscription still genuinely in-flight through the renewal/
// retry pipeline but recovers a genuinely stale one; and
// enforceGracePeriodSuspensions publishes the new versioned
// GraceExpired.v1/GraceConvertedToSuspension.v1 events.
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

test("GracePeriodEngineService.startGracePeriod: real per-plan grace days, explicit graceStartedAt, idempotent no-op when not eligible", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const GracePeriodEngineService = (await import("../services/GracePeriodEngineService.js")).default;

  const suffix = `grace-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ action: "GRACE_PERIOD_STARTED", tenantId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Professional", tier: "Professional", pricing: { currency: "USD", monthly: 99 }, gracePeriodDays: 7 });
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 99, currency: "USD",
    status: "PastDue", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 5 * 86400000)
  });

  const before = Date.now();
  const { started, subscription: updated } = await GracePeriodEngineService.startGracePeriod(subscription._id, { reason: "Test retries exhausted." });
  assert.equal(started, true);
  assert.equal(updated.status, "GracePeriod");
  assert.ok(new Date(updated.graceStartedAt).getTime() >= before, "graceStartedAt must be the real moment grace started, not the old currentPeriodEnd");
  const expectedEnd = new Date(updated.graceStartedAt).getTime() + 7 * 86400000;
  assert.equal(new Date(updated.gracePeriodEndsAt).getTime(), expectedEnd, "grace end must use the plan's own real 7-day gracePeriodDays");

  const auditEntry = await AuditLogModel.findOne({ action: "GRACE_PERIOD_STARTED", tenantId }).lean();
  assert.ok(auditEntry, "every grace start MUST be audited");
  assert.equal(auditEntry.details.graceDays, 7);

  // Idempotent — already in GracePeriod, calling again is a real no-op (never restarts the countdown).
  const second = await GracePeriodEngineService.startGracePeriod(subscription._id);
  assert.equal(second.started, false);
  assert.equal(new Date(second.subscription.graceStartedAt).getTime(), new Date(updated.graceStartedAt).getTime(), "a second call must not reset the real grace start time");
});

test("SubscriptionRenewalEngineService.processRenewal: a terminal (non-retryable) failure immediately starts GracePeriod — real event-driven trigger, not waiting for the next daily sweep", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const SubscriptionRenewalEngineService = (await import("../services/SubscriptionRenewalEngineService.js")).default;

  const suffix = `eventdriven-${Date.now()}`;
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
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 }, gracePeriodDays: 3 });
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });

  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "Active", autoRenew: true, currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: new Date(Date.now() - 1000)
  });

  const { renewal } = await SubscriptionRenewalEngineService.processRenewal(subscription._id);
  assert.equal(renewal.status, "Failed", "no Stripe payment method classifies NonRetryable and exhausts on the first attempt");

  const reloaded = await TenantSubscriptionModel.findOne({ _id: subscription._id }).lean();
  assert.equal(reloaded.status, "GracePeriod", "grace must start IMMEDIATELY as part of this same call — the real event-driven trigger");
  assert.ok(reloaded.graceStartedAt);
  const expectedGraceEnd = new Date(reloaded.graceStartedAt).getTime() + 3 * 86400000;
  assert.equal(new Date(reloaded.gracePeriodEndsAt).getTime(), expectedGraceEnd);
});

test("_onPaymentReceived: a real payment received during GracePeriod immediately restores Active and records graceEndedAt (GracePaymentReceived.v1)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `recover-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const unsub = subscribeEvent("GracePaymentReceived.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
    if (typeof unsub === "function") unsub();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  const graceStartedAt = new Date(Date.now() - 2 * 86400000);
  const subscription = await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 60 * 86400000), currentPeriodEnd: new Date(Date.now() - 5 * 86400000),
    graceStartedAt, gracePeriodEndsAt: new Date(Date.now() + 1 * 86400000)
  });
  const invoice = await SubscriptionInvoiceModel.create({
    tenantId, invoiceNumber: `TEST-INV-${suffix}`, subscriptionId: subscription._id, invoiceType: "Renewal",
    billingPeriodStart: subscription.currentPeriodEnd, billingPeriodEnd: new Date(Date.now() + 25 * 86400000),
    amount: 29, currency: "USD", dueDate: subscription.currentPeriodEnd, status: "Sent"
  });

  await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: "TEST-REF", userId: "tester" });

  const reloaded = await TenantSubscriptionModel.findOne({ _id: subscription._id }).lean();
  assert.equal(reloaded.status, "Active");
  assert.ok(reloaded.graceEndedAt, "a real recovery-during-grace must record graceEndedAt");
  assert.ok(new Date(reloaded.graceEndedAt).getTime() >= graceStartedAt.getTime());

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(receivedEvents.length, 1, "GracePaymentReceived.v1 must publish exactly once for this real recovery");
  assert.equal(receivedEvents[0].data.amount, 29);
});

test("runDailyLifecycleSweep safety net: skips a subscription with an in-flight retry, but recovers a genuinely stale overdue one with no renewal row at all", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `safetynet-${Date.now()}`;
  const inFlightTenantId = `test-inflight-${suffix}`;
  const staleTenantId = `test-stale-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: [inFlightTenantId, staleTenantId] } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: [inFlightTenantId, staleTenantId] } });
    await SubscriptionRenewalModel.deleteMany({ tenantId: { $in: [inFlightTenantId, staleTenantId] } });
  });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 }, gracePeriodDays: 5 });

  await TenantModel.create({ tenantKey: inFlightTenantId, name: "In-flight tenant", status: "active" });
  const overduePeriodEnd = new Date(Date.now() - 2 * 86400000); // > 1 day buffer, so it's a safety-net candidate by date
  const inFlightSubscription = await TenantSubscriptionModel.create({
    tenantId: inFlightTenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "PastDue", autoRenew: true, currentPeriodStart: new Date(Date.now() - 32 * 86400000), currentPeriodEnd: overduePeriodEnd
  });
  await SubscriptionRenewalModel.create({
    renewalId: `test-renewal-inflight-${suffix}`, tenantId: inFlightTenantId, subscriptionId: inFlightSubscription._id, billingCycle: "Monthly",
    renewalDate: overduePeriodEnd, subtotal: 29, finalAmount: 29, currency: "USD", status: "Retrying", startedAt: new Date(), nextRetryAt: new Date(Date.now() + 86400000)
  });

  await TenantModel.create({ tenantKey: staleTenantId, name: "Stale tenant", status: "active" });
  const staleSubscription = await TenantSubscriptionModel.create({
    tenantId: staleTenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "PastDue", autoRenew: true, currentPeriodStart: new Date(Date.now() - 32 * 86400000), currentPeriodEnd: overduePeriodEnd
  });
  // No SubscriptionRenewalModel row at all for the stale one — as if the renewal engine never picked it up.

  await TenantSubscriptionService.runDailyLifecycleSweep();

  const reloadedInFlight = await TenantSubscriptionModel.findOne({ _id: inFlightSubscription._id }).lean();
  assert.equal(reloadedInFlight.status, "PastDue", "a subscription still genuinely retrying must NOT be pushed into GracePeriod by the safety net");

  const reloadedStale = await TenantSubscriptionModel.findOne({ _id: staleSubscription._id }).lean();
  assert.equal(reloadedStale.status, "GracePeriod", "a genuinely stale overdue subscription with no active renewal must be recovered by the safety net");
  assert.ok(reloadedStale.graceStartedAt);
});

test("enforceGracePeriodSuspensions: publishes the new versioned GraceExpired.v1 and GraceConvertedToSuspension.v1 events around the real suspend", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `graceexpire-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const unsubExpired = subscribeEvent("GraceExpired.v1", (payload) => receivedEvents.push(payload));
  const unsubConverted = subscribeEvent("GraceConvertedToSuspension.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    if (typeof unsubExpired === "function") unsubExpired();
    if (typeof unsubConverted === "function") unsubConverted();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD",
    status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 40 * 86400000), currentPeriodEnd: new Date(Date.now() - 10 * 86400000),
    graceStartedAt: new Date(Date.now() - 3 * 86400000), gracePeriodEndsAt: new Date(Date.now() - 1000)
  });

  const result = await TenantSubscriptionService.enforceGracePeriodSuspensions();
  assert.ok(result.suspended >= 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const expiredEvent = receivedEvents.find((e) => e.eventName === "GraceExpired");
  const convertedEvent = receivedEvents.find((e) => e.eventName === "GraceConvertedToSuspension");
  assert.ok(expiredEvent, "GraceExpired.v1 must publish");
  assert.ok(convertedEvent, "GraceConvertedToSuspension.v1 must publish once the suspend genuinely succeeds");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
