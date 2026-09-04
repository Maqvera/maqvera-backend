import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CommunicationPlatformService from "./CommunicationPlatformService.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import { getDeliveryAdapter } from "./delivery/index.js";
import { publishVersionedEvent } from "../utils/eventVersioning.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import logger from "../utils/logger.js";
import {
  RENEWAL_REMINDER_TEMPLATES,
  PAYMENT_FAILED_TEMPLATE,
  RETRY_SCHEDULED_TEMPLATE,
  SUSPENSION_TEMPLATE,
  REACTIVATION_TEMPLATE
} from "../utils/subscriptionNotificationTemplates.js";

const EVENT_OWNER = "Enterprise Subscription Automation Layer";

/** Real IANA-timezone + "HH:mm" window check — built-in `Intl`, no new dependency. Fails OPEN (never blocks a real notification) on a malformed timezone/window rather than throwing. */
const isWithinQuietHours = (billingAccount, now = new Date()) => {
  if (!billingAccount?.quietHoursEnabled || !billingAccount.quietHoursStart || !billingAccount.quietHoursEnd) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: billingAccount.timezone || "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const currentMinutes = hour * 60 + minute;

    const [startH, startM] = billingAccount.quietHoursStart.split(":").map(Number);
    const [endH, endM] = billingAccount.quietHoursEnd.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    if (startMinutes === endMinutes) return false;

    return startMinutes < endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes; // window wraps midnight, e.g. 22:00 -> 08:00
  } catch {
    return false;
  }
};

/** Real escalation-contact resolution — reuses TenantBillingAccountModel.contacts[] (Improvement 3's own real, config-driven `billingContactTypes`), falling back to the always-present Primary contact fields. Never a second, parallel contacts system. */
const resolveRecipients = (billingAccount, contactTypes) => {
  if (!billingAccount) return [];
  const matched = (billingAccount.contacts || []).filter((c) => contactTypes.includes(c.contactType) && c.email);
  if (matched.length > 0) return matched.map((c) => ({ email: c.email, phone: c.phone || null, name: c.name || null, contactType: c.contactType }));
  if (billingAccount.billingContactEmail) return [{ email: billingAccount.billingContactEmail, phone: billingAccount.billingContactPhone || null, name: billingAccount.billingContactName || null, contactType: "Primary" }];
  return [];
};

/**
 * Enterprise Subscription Automation Layer — Automation #7 (Enterprise
 * Notification Timeline). The real orchestrator on top of the ALREADY-real
 * Enterprise Communication Platform (`CommunicationPlatformService` —
 * multi-channel dispatch, delivery tracking, retry, audit, preference/DND
 * enforcement — none of that is rebuilt here). This service's own job:
 * deciding WHICH subscription-lifecycle moment triggers WHICH real
 * template, to WHICH real escalation contacts, respecting real quiet
 * hours — then handing off to the existing platform for the actual send.
 *
 * **Honestly not built**: "Preferred Language" — no localization/i18n
 * infrastructure exists anywhere in this codebase to translate a rendered
 * template into; every template here is English-only. "Primary Provider
 * -> Secondary Provider" failover — only one real provider exists per
 * channel anywhere in this codebase (nodemailer for Email, Twilio for
 * SMS/WhatsApp), so there is nothing real to fail over TO; `CommunicationPlatformService.retryMessage`
 * already provides real same-provider retry. "Opened/Clicked" delivery
 * tracking — would need a public tracking pixel/link-rewriting
 * infrastructure this codebase doesn't have; `CommunicationMessageModel`
 * already tracks the real, honest states through Delivered/Failed.
 */
class SubscriptionNotificationService {
  /**
   * The one real send chokepoint every lifecycle notification below funnels
   * through — quiet-hours gating, recipient resolution, template
   * rendering, real dispatch (Email always; SMS additionally for
   * `critical` notifications when a recipient has a real phone number),
   * spec-shaped `NOTIFICATION_SENT` audit entry, and the caller's own
   * versioned domain event.
   */
  static async _send(tenantId, { template, variables, contactTypes, critical = false, eventName, notificationKey }) {
    const billingAccount = await TenantBillingAccountModel.findOne({ tenantId }).lean();
    if (!billingAccount) return { sent: false, reason: "NoBillingAccount" };

    if (!critical && isWithinQuietHours(billingAccount)) {
      await AuditLogModel.create({ action: "NOTIFICATION_SKIPPED", module: "Platform", resource: "TenantBillingAccount", resourceId: tenantId, userId: null, tenantId, details: { merchantId: tenantId, template: notificationKey, reason: "QuietHours" } });
      return { sent: false, reason: "QuietHours" };
    }

    const recipients = resolveRecipients(billingAccount, contactTypes);
    if (recipients.length === 0) return { sent: false, reason: "NoRecipients" };

    const config = getPlatformConfig();
    const renderVariables = { ...variables, paymentLink: config.platformBillingPortalUrl ? `Pay now: ${config.platformBillingPortalUrl}` : "", supportUrl: config.platformSupportUrl || "" };
    const subject = CommunicationTemplateService.renderTemplate(template.subject, renderVariables);
    const body = CommunicationTemplateService.renderTemplate(template.body, renderVariables);

    const results = [];
    for (const recipient of recipients) {
      const emailResult = await CommunicationPlatformService.requestCommunication({
        tenantId, sourceModule: "Platform", channel: "Email",
        recipient: { email: recipient.email }, subject, content: body, priority: critical ? "High" : "Normal", userId: null
      });
      results.push(emailResult);

      // "SMS (Optional): High Priority" — real, additional channel only
      // for critical notifications, only when a real phone number exists;
      // honestly no-op (CommunicationPlatformService's own real
      // "NotConfigured" status) when Twilio isn't configured.
      if (critical && recipient.phone && getDeliveryAdapter("SMS")) {
        const smsResult = await CommunicationPlatformService.requestCommunication({
          tenantId, sourceModule: "Platform", channel: "SMS",
          recipient: { phone: recipient.phone }, content: body, priority: "High", userId: null
        }).catch((error) => { logger.warn(`SMS notification failed for tenant ${tenantId}.`, { error: error.message }); return null; });
        if (smsResult) results.push(smsResult);
      }

      await AuditLogModel.create({
        action: "NOTIFICATION_SENT", module: "Platform", resource: "TenantBillingAccount", resourceId: tenantId, userId: null, tenantId,
        details: { merchantId: tenantId, template: notificationKey, channel: "Email", status: emailResult.status, recipient: recipient.email }
      });
    }

    if (eventName) {
      await publishVersionedEvent({ eventName, version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, data: { tenantId, template: notificationKey, recipientCount: recipients.length } });
    }

    return { sent: true, recipientCount: recipients.length, results };
  }

  /** "Renewal Reminder Timeline... 30/14/7/3/1 Days Before." `daysRemaining` must be one of the configured milestones — the caller (TenantSubscriptionService's daily sweep) already gates on that. */
  static async sendRenewalReminder(tenantId, daysRemaining, variables) {
    const template = RENEWAL_REMINDER_TEMPLATES[daysRemaining];
    if (!template) return { sent: false, reason: "NoTemplateForMilestone" };
    return SubscriptionNotificationService._send(tenantId, { template, variables, contactTypes: ["Primary", "Finance"], critical: false, eventName: "RenewalReminderSent", notificationKey: `RenewalReminder${daysRemaining}` });
  }

  /** "Payment Failed -> Immediate Notification." Fires on every real failed attempt — the first (Automation #2) and every retry (Automation #3) — `attemptNumber` in `variables` differentiates the wording context. */
  static async sendPaymentFailedNotification(tenantId, variables) {
    return SubscriptionNotificationService._send(tenantId, { template: PAYMENT_FAILED_TEMPLATE, variables, contactTypes: ["Primary", "Finance"], critical: false, eventName: "PaymentFailedNotificationSent", notificationKey: "PaymentFailed" });
  }

  /** "Retry Scheduled." Fires only when a retry genuinely will happen (PaymentRetryEngineService.handleFailure's own non-exhausted branch). */
  static async sendRetryScheduledNotification(tenantId, variables) {
    return SubscriptionNotificationService._send(tenantId, { template: RETRY_SCHEDULED_TEMPLATE, variables, contactTypes: ["Primary", "Finance"], critical: false, eventName: "PaymentFailedNotificationSent", notificationKey: "RetryScheduled" });
  }

  /**
   * "Suspension Notification... Reason, Suspension Time, Outstanding
   * Balance, Payment Link, Support Contact, Reactivation Instructions. No
   * ambiguity." Critical — bypasses quiet hours, fans out to EVERY real
   * escalation contact type (not just Primary/Finance), and additionally
   * attempts SMS for anyone with a phone number on file.
   */
  static async sendSuspensionNotification(tenantId, variables) {
    return SubscriptionNotificationService._send(tenantId, { template: SUSPENSION_TEMPLATE, variables, contactTypes: ["Primary", "Finance", "Technical", "Tax", "Legal", "Collection"], critical: true, eventName: "SuspensionNotificationSent", notificationKey: "Suspended" });
  }

  /** "Reactivation Notification... Payment Confirmed -> Subscription Active -> Access Restored -> Welcome Back. Automatic." */
  static async sendReactivationNotification(tenantId, variables) {
    return SubscriptionNotificationService._send(tenantId, { template: REACTIVATION_TEMPLATE, variables, contactTypes: ["Primary", "Finance"], critical: false, eventName: "ReactivationNotificationSent", notificationKey: "Reactivated" });
  }
}

export default SubscriptionNotificationService;
