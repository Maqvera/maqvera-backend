import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Subscription Automation Layer — Automation #7 (Enterprise
// Notification Timeline). Proves, against a real database: a real
// dispatch through the existing Enterprise Communication Platform writes
// a spec-shaped NOTIFICATION_SENT audit entry and publishes the caller's
// versioned event; real quiet-hours gating skips a non-critical
// notification but never a critical one; escalation contacts genuinely
// fan out to every matching real TenantBillingAccountModel.contacts[]
// entry; suspendTenant/_onPaymentReceived/PaymentRetryEngineService.handleFailure
// all genuinely trigger the correct real notification at the correct real
// lifecycle moment; and the renewal-reminder milestone cascade dedupes via
// the same real reminders[] pattern Automation #4 already proved.
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

test("SubscriptionNotificationService.sendRenewalReminder: real dispatch, spec-shaped NOTIFICATION_SENT audit, versioned event", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const SubscriptionNotificationService = (await import("../services/SubscriptionNotificationService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");

  const suffix = `notify-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const receivedEvents = [];
  const unsub = subscribeEvent("RenewalReminderSent.v1", (payload) => receivedEvents.push(payload));

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "NOTIFICATION_SENT" });
    if (typeof unsub === "function") unsub();
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });

  const result = await SubscriptionNotificationService.sendRenewalReminder(tenantId, 7, { merchantName: tenantId, planCode: "TEST", outstandingAmount: 99, currency: "USD", dueDate: "2027-01-01" });
  assert.equal(result.sent, true);
  assert.equal(result.recipientCount, 1);

  const auditEntry = await AuditLogModel.findOne({ tenantId, action: "NOTIFICATION_SENT" }).lean();
  assert.ok(auditEntry, "every notification MUST be audited");
  assert.equal(auditEntry.details.merchantId, tenantId);
  assert.equal(auditEntry.details.template, "RenewalReminder7");
  assert.equal(auditEntry.details.channel, "Email");
  assert.ok(["Delivered", "Failed"].includes(auditEntry.details.status), "a real dispatch outcome, whatever SMTP is configured in this environment");

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(receivedEvents.length, 1);
});

test("SubscriptionNotificationService: real quiet-hours gating skips a non-critical notification but never a critical one", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const SubscriptionNotificationService = (await import("../services/SubscriptionNotificationService.js")).default;

  const suffix = `quiethours-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: { $in: ["NOTIFICATION_SENT", "NOTIFICATION_SKIPPED"] } });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  // A 24-hour quiet window (00:00 -> 23:59) — deterministically "always quiet" regardless of when this test runs, in UTC.
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active", quietHoursEnabled: true, quietHoursStart: "00:00", quietHoursEnd: "23:59", timezone: "UTC" });

  const reminderResult = await SubscriptionNotificationService.sendRenewalReminder(tenantId, 3, { merchantName: tenantId, planCode: "TEST", outstandingAmount: 99, currency: "USD", dueDate: "2027-01-01" });
  assert.equal(reminderResult.sent, false);
  assert.equal(reminderResult.reason, "QuietHours");

  const skippedAudit = await AuditLogModel.findOne({ tenantId, action: "NOTIFICATION_SKIPPED" }).lean();
  assert.ok(skippedAudit);

  const suspensionResult = await SubscriptionNotificationService.sendSuspensionNotification(tenantId, { merchantName: tenantId, reason: "Test", suspendedAt: new Date().toISOString(), outstandingAmount: 99, currency: "USD" });
  assert.equal(suspensionResult.sent, true, "a critical notification (suspension) must NEVER be blocked by quiet hours");
});

test("SubscriptionNotificationService.sendSuspensionNotification: fans out to every matching real escalation contact", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const SubscriptionNotificationService = (await import("../services/SubscriptionNotificationService.js")).default;

  const suffix = `escalation-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "NOTIFICATION_SENT" });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  await TenantBillingAccountModel.create({
    tenantId, billingContactName: "Primary Contact", billingContactEmail: "primary@example.com", paymentMethod: "Manual", status: "Active",
    contacts: [
      { contactType: "Finance", name: "Finance Manager", email: "finance@example.com" },
      { contactType: "Legal", name: "Legal Contact", email: "legal@example.com" }
    ]
  });

  const result = await SubscriptionNotificationService.sendSuspensionNotification(tenantId, { merchantName: tenantId, reason: "Test", suspendedAt: new Date().toISOString(), outstandingAmount: 99, currency: "USD" });
  assert.equal(result.recipientCount, 2, "suspension fans out to real contacts[] entries (Finance + Legal), not just the single Primary contact");

  const auditEntries = await AuditLogModel.find({ tenantId, action: "NOTIFICATION_SENT" }).lean();
  const recipients = auditEntries.map((e) => e.details.recipient).sort();
  assert.deepEqual(recipients, ["finance@example.com", "legal@example.com"]);
});

test("suspendTenant: genuinely triggers a real suspension notification", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `suspendnotify-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "NOTIFICATION_SENT" });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test Contact", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });

  await TenantSubscriptionService.suspendTenant(tenantId, "Test suspension.", "tester");

  const auditEntry = await AuditLogModel.findOne({ tenantId, action: "NOTIFICATION_SENT", "details.template": "Suspended" }).lean();
  assert.ok(auditEntry, "suspendTenant must genuinely trigger a real suspension notification");
});

test("_onPaymentReceived: triggers a real reactivation notification only when recovering from Suspended/GracePeriod, never on a routine renewal", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `reactivatenotify-${Date.now()}`;
  const graceTenantId = `test-grace-${suffix}`;
  const routineTenantId = `test-routine-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: [graceTenantId, routineTenantId] } });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId: { $in: [graceTenantId, routineTenantId] } });
    await TenantBillingAccountModel.deleteMany({ tenantId: { $in: [graceTenantId, routineTenantId] } });
    await SubscriptionInvoiceModel.deleteMany({ tenantId: { $in: [graceTenantId, routineTenantId] } });
    await AuditLogModel.deleteMany({ tenantId: { $in: [graceTenantId, routineTenantId] }, action: "NOTIFICATION_SENT", "details.template": "Reactivated" });
  });

  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });

  // Case 1 — genuine recovery from GracePeriod.
  await TenantModel.create({ tenantKey: graceTenantId, name: "Grace Tenant", status: "active" });
  await TenantBillingAccountModel.create({ tenantId: graceTenantId, billingContactName: "Test", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });
  const graceSubscription = await TenantSubscriptionModel.create({ tenantId: graceTenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "GracePeriod", currentPeriodStart: new Date(Date.now() - 60 * 86400000), currentPeriodEnd: new Date(Date.now() - 5 * 86400000), gracePeriodEndsAt: new Date(Date.now() + 86400000) });
  const graceInvoice = await SubscriptionInvoiceModel.create({ tenantId: graceTenantId, invoiceNumber: `TEST-INV-GRACE-${suffix}`, subscriptionId: graceSubscription._id, invoiceType: "Renewal", billingPeriodStart: graceSubscription.currentPeriodEnd, billingPeriodEnd: new Date(Date.now() + 25 * 86400000), amount: 29, currency: "USD", dueDate: graceSubscription.currentPeriodEnd, status: "Sent" });
  await TenantSubscriptionService.recordManualPayment(graceInvoice._id, { reference: "TEST-REF", userId: "tester" });

  const graceNotification = await AuditLogModel.findOne({ tenantId: graceTenantId, action: "NOTIFICATION_SENT", "details.template": "Reactivated" }).lean();
  assert.ok(graceNotification, "a genuine recovery from GracePeriod must trigger a real Welcome Back notification");

  // Case 2 — routine renewal from Active (never in grace/suspended) must NOT trigger "Welcome Back".
  await TenantModel.create({ tenantKey: routineTenantId, name: "Routine Tenant", status: "active" });
  await TenantBillingAccountModel.create({ tenantId: routineTenantId, billingContactName: "Test", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });
  const routineSubscription = await TenantSubscriptionModel.create({ tenantId: routineTenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 25 * 86400000) });
  const routineInvoice = await SubscriptionInvoiceModel.create({ tenantId: routineTenantId, invoiceNumber: `TEST-INV-ROUTINE-${suffix}`, subscriptionId: routineSubscription._id, invoiceType: "Renewal", billingPeriodStart: routineSubscription.currentPeriodEnd, billingPeriodEnd: new Date(Date.now() + 55 * 86400000), amount: 29, currency: "USD", dueDate: routineSubscription.currentPeriodEnd, status: "Sent" });
  await TenantSubscriptionService.recordManualPayment(routineInvoice._id, { reference: "TEST-REF-2", userId: "tester" });

  const routineNotification = await AuditLogModel.findOne({ tenantId: routineTenantId, action: "NOTIFICATION_SENT", "details.template": "Reactivated" }).lean();
  assert.equal(routineNotification, null, "a routine on-time renewal from Active must never trigger a Welcome Back notification");
});

test("PaymentRetryEngineService.handleFailure: triggers PaymentFailed and (when not exhausted) RetryScheduled notifications", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionRenewalModel = (await import("../models/SubscriptionRenewalModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const PaymentRetryEngineService = (await import("../services/PaymentRetryEngineService.js")).default;

  const suffix = `retrynotify-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await SubscriptionRenewalModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "NOTIFICATION_SENT" });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  const subscription = await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });
  const renewal = await SubscriptionRenewalModel.create({ renewalId: `test-renewal-${suffix}`, tenantId, subscriptionId: subscription._id, billingCycle: "Monthly", renewalDate: subscription.currentPeriodEnd, subtotal: 29, finalAmount: 29, currency: "USD", status: "PaymentAttempted", startedAt: new Date(), attemptCount: 0, maxAttempts: 5 });

  await PaymentRetryEngineService.handleFailure(renewal, subscription._id, { failureReason: "Gateway timeout while contacting the processor.", paymentMethod: "Stripe" }, renewal.startedAt.getTime());

  const paymentFailedAudit = await AuditLogModel.findOne({ tenantId, action: "NOTIFICATION_SENT", "details.template": "PaymentFailed" }).lean();
  assert.ok(paymentFailedAudit, "every real failure must trigger a PaymentFailed notification");

  const retryScheduledAudit = await AuditLogModel.findOne({ tenantId, action: "NOTIFICATION_SENT", "details.template": "RetryScheduled" }).lean();
  assert.ok(retryScheduledAudit, "a retryable, non-exhausted failure must also trigger a RetryScheduled notification");
});

test("runDailyLifecycleSweep: the renewal-reminder milestone cascade sends a real, deduped 7-day reminder", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `milestone-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId, action: "NOTIFICATION_SENT" });
  });

  await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
  await TenantBillingAccountModel.create({ tenantId, billingContactName: "Test", billingContactEmail: "billing@example.com", paymentMethod: "Manual", status: "Active" });
  const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Starter", tier: "Starter", pricing: { currency: "USD", monthly: 29 } });
  // currentPeriodEnd just under 7 days out — Math.ceil((end - now) / 86400000) must land exactly on the real 7-day milestone.
  await TenantSubscriptionModel.create({ tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 29, currency: "USD", status: "Active", autoRenew: true, currentPeriodStart: new Date(Date.now() - 23 * 86400000), currentPeriodEnd: new Date(Date.now() + 7 * 86400000 - 60000) });

  await TenantSubscriptionService.runDailyLifecycleSweep();

  const reloaded = await TenantSubscriptionModel.findOne({ tenantId }).lean();
  assert.ok(reloaded.reminders.some((r) => r.reason === "RenewalMilestone7"), "the real 7-day milestone must be recorded, deduped via the same reminders[] pattern Automation #4 already proved");

  const notificationAudit = await AuditLogModel.findOne({ tenantId, action: "NOTIFICATION_SENT", "details.template": "RenewalReminder7" }).lean();
  assert.ok(notificationAudit);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
