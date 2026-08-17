import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #9 (Enterprise
// Automatic Reactivation Workflow). Proves, against a real database: a
// real payment received while Suspended automatically flows through
// PaymentVerified.v1 -> InvoiceSettled.v1 -> real access restoration
// (reactivateTenant) -> the spec-shaped MERCHANT_REACTIVATED audit entry
// and its versioned event set; a real `reactivationHold` genuinely blocks
// that automatic restoration while still recording the payment fact, and
// `resolveReactivationHold` genuinely finishes the job afterward,
// including the configurable subscription-extension policy; and the
// monitoring dashboard returns real live figures.
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

async function makeSuspendedTenant({ suffix, TenantModel, PlatformPlanModel, TenantSubscriptionModel, TenantSubscriptionService, amount = 29 }) {
  const tenantId = `test-${suffix}`;
  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Test Plan", tier: "Starter", pricing: { currency: "USD", monthly: amount } });
  await TenantSubscriptionModel.create({
    tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount, currency: "USD",
    status: "Active", currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: new Date(Date.now() - 1 * 86400000)
  });
  await TenantSubscriptionService.suspendTenant(tenantId, "Test suspension for reactivation workflow.", "tester");
  return { tenantId, plan };
}

test("_onPaymentReceived: a real payment while Suspended automatically restores access with the full versioned event/audit trail", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `reactivate9-${Date.now()}`;
  const receivedEvents = [];
  const eventNames = ["PaymentVerified.v1", "InvoiceSettled.v1", "MerchantReactivated.v1", "AccessRestored.v1", "BackgroundJobsResumed.v1", "IntegrationsRestored.v1"];
  const unsubs = eventNames.map((name) => subscribeEvent(name, (payload) => receivedEvents.push({ name, payload })));

  t.after(async () => {
    const { tenantId } = ctx;
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: { $in: ["MERCHANT_REACTIVATED", "platform.tenant.reactivate"] } });
    unsubs.forEach((unsub) => { if (typeof unsub === "function") unsub(); });
  });

  const ctx = await makeSuspendedTenant({ suffix, TenantModel, PlatformPlanModel, TenantSubscriptionModel, TenantSubscriptionService });
  const { tenantId } = ctx;

  const invoice = await SubscriptionInvoiceModel.create({
    tenantId, invoiceNumber: `TEST-INV-${suffix}`, subscriptionId: (await TenantSubscriptionModel.findOne({ tenantId }))._id, invoiceType: "Renewal",
    billingPeriodStart: new Date(), billingPeriodEnd: new Date(Date.now() + 30 * 86400000),
    amount: 29, currency: "USD", dueDate: new Date(), status: "Sent"
  });

  const paidInvoice = await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: "TEST-REF", userId: "tester" });
  assert.equal(paidInvoice.status, "Paid");

  const reloadedTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedTenant.status, "active", "a real payment while Suspended must automatically restore Tenant-level access");

  const auditEntry = await AuditLogModel.findOne({ tenantId, action: "MERCHANT_REACTIVATED" }).lean();
  assert.ok(auditEntry, "the spec-shaped MERCHANT_REACTIVATED audit entry must be written");
  assert.equal(auditEntry.details.merchantId, tenantId);
  assert.equal(auditEntry.details.paymentId, invoice._id.toString());
  assert.equal(auditEntry.details.automatic, true);
  assert.ok(auditEntry.details.reactivatedAt);

  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const name of eventNames) {
    assert.ok(receivedEvents.some((e) => e.name === name), `${name} must publish on a real automatic reactivation`);
  }
  const merchantReactivatedEvent = receivedEvents.find((e) => e.name === "MerchantReactivated.v1");
  assert.equal(merchantReactivatedEvent.payload.data.automatic, true);
  assert.equal(merchantReactivatedEvent.payload.data.paymentId, invoice._id.toString());
});

test("reactivationHold: blocks automatic access restoration while still recording the payment, then resolveReactivationHold(approve:true) finishes the job", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `hold9-${Date.now()}`;
  const receivedEvents = [];
  const unsub = subscribeEvent("ReactivationBlockedForReview.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    const { tenantId } = ctx;
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: { $regex: "^REACTIVATION" } });
    if (typeof unsub === "function") unsub();
  });

  const ctx = await makeSuspendedTenant({ suffix, TenantModel, PlatformPlanModel, TenantSubscriptionModel, TenantSubscriptionService });
  const { tenantId } = ctx;

  await TenantSubscriptionService.setReactivationHold(tenantId, { holdType: "Chargeback", reason: "Disputed charge under investigation.", userId: "compliance-officer" });

  const subscriptionBefore = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(subscriptionBefore.reactivationHold, true);

  const invoice = await SubscriptionInvoiceModel.create({
    tenantId, invoiceNumber: `TEST-INV-${suffix}`, subscriptionId: subscriptionBefore._id, invoiceType: "Renewal",
    billingPeriodStart: new Date(), billingPeriodEnd: new Date(Date.now() + 30 * 86400000),
    amount: 29, currency: "USD", dueDate: new Date(), status: "Sent"
  });

  await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: "TEST-REF", userId: "tester" });

  const reloadedTenantStillSuspended = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedTenantStillSuspended.status, "suspended", "a held tenant must NOT be automatically reactivated even though payment was received");

  const reloadedSubStillSuspended = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(reloadedSubStillSuspended.status, "Suspended", "the subscription itself must stay genuinely Suspended so enforcement keeps blocking");
  assert.ok(reloadedSubStillSuspended.lastPaymentAt, "the real fact that payment arrived must still be recorded for Finance");

  const block = await TenantSubscriptionService.getEnforcementBlock(tenantId);
  assert.ok(block, "per-request enforcement must still genuinely block this tenant while the hold is active");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(receivedEvents.length, 1, "ReactivationBlockedForReview.v1 must publish exactly once");
  assert.equal(receivedEvents[0].data.holdType, "Chargeback");

  const result = await TenantSubscriptionService.resolveReactivationHold(tenantId, { approve: true, reason: "Chargeback dismissed, funds released.", userId: "compliance-officer" });
  assert.equal(result.approved, true);
  assert.equal(result.status, "active");

  const finalTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(finalTenant.status, "active", "approving the hold must genuinely finish the real reactivation");

  const finalSub = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(finalSub.status, "Active");
  assert.equal(finalSub.reactivationHold, false);

  const finalBlock = await TenantSubscriptionService.getEnforcementBlock(tenantId);
  assert.equal(finalBlock, null);
});

test("resolveReactivationHold(approve:false) rejects and never restores access", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `holdreject9-${Date.now()}`;

  t.after(async () => {
    const { tenantId } = ctx;
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
  });

  const ctx = await makeSuspendedTenant({ suffix, TenantModel, PlatformPlanModel, TenantSubscriptionModel, TenantSubscriptionService });
  const { tenantId } = ctx;

  await TenantSubscriptionService.setReactivationHold(tenantId, { holdType: "Fraud", reason: "Suspected fraudulent account.", userId: "compliance-officer" });
  const result = await TenantSubscriptionService.resolveReactivationHold(tenantId, { approve: false, reason: "Confirmed fraudulent.", userId: "compliance-officer" });
  assert.equal(result.approved, false);

  const finalTenant = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(finalTenant.status, "suspended", "a rejected hold must never restore access");

  const finalSub = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.equal(finalSub.reactivationHold, false, "the hold flag itself is cleared even on rejection — resolved, not reactivated");
});

test("Subscription extension policy: FromPaymentDate extends the new period from the real payment date, not the original expiry date", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `extpolicy9-${Date.now()}`;
  const previousPolicy = process.env.PLATFORM_REACTIVATION_EXTENSION_POLICY;
  process.env.PLATFORM_REACTIVATION_EXTENSION_POLICY = "FromPaymentDate";

  t.after(async () => {
    const { tenantId } = ctx;
    if (previousPolicy === undefined) delete process.env.PLATFORM_REACTIVATION_EXTENSION_POLICY;
    else process.env.PLATFORM_REACTIVATION_EXTENSION_POLICY = previousPolicy;
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
  });

  const ctx = await makeSuspendedTenant({ suffix, TenantModel, PlatformPlanModel, TenantSubscriptionModel, TenantSubscriptionService });
  const { tenantId } = ctx;
  const originalExpiry = (await TenantSubscriptionModel.findOne({ tenantId }).lean()).currentPeriodEnd;

  const invoice = await SubscriptionInvoiceModel.create({
    tenantId, invoiceNumber: `TEST-INV-${suffix}`, subscriptionId: (await TenantSubscriptionModel.findOne({ tenantId }))._id, invoiceType: "Renewal",
    billingPeriodStart: originalExpiry, billingPeriodEnd: new Date(originalExpiry.getTime() + 30 * 86400000),
    amount: 29, currency: "USD", dueDate: new Date(), status: "Sent"
  });

  const before = Date.now();
  await TenantSubscriptionService.recordManualPayment(invoice._id, { reference: "TEST-REF", userId: "tester" });
  const after = Date.now();

  const reloaded = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.ok(new Date(reloaded.currentPeriodStart).getTime() >= before && new Date(reloaded.currentPeriodStart).getTime() <= after, "the new period must start from the real payment moment, not the original expiry date");
  assert.notEqual(new Date(reloaded.currentPeriodStart).getTime(), new Date(originalExpiry).getTime());
});

test("Reactivation workflow monitoring dashboard: getReactivationDashboard returns real live figures", { skip: !dbAvailable && dbSkipReason }, async () => {
  const { getReactivationDashboard } = await import("../controllers/TenantSubscriptionController.js");

  const req = { auth: { permissions: ["admin"] }, requestId: "test-req-id" };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; }
  };

  await getReactivationDashboard(req, res);

  assert.equal(statusCode, 200);
  assert.ok(payload.success);
  const { data } = payload;
  assert.equal(typeof data.todaysReactivations, "number");
  assert.equal(typeof data.automaticReactivations, "number");
  assert.equal(typeof data.manualReviewsPending, "number");
  assert.equal(typeof data.failedReactivationsToday, "number");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
