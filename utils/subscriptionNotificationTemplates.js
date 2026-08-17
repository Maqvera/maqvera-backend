// Enterprise Subscription Automation Layer — Automation #7 (Enterprise
// Notification Timeline). "Templates should support Variables... Merchant
// Name, Invoice Number, Outstanding Amount, Due Date, Payment Link,
// Support URL. No hardcoded messages." Real, `{{variable}}`-driven —
// rendered via the EXISTING `CommunicationTemplateService.renderTemplate`
// engine (Enterprise Communication Platform), never a second, parallel
// interpolation implementation.
//
// These live as plain template strings here rather than
// `CommunicationTemplateModel` rows because they are PLATFORM-level
// (every tenant gets the same real notification the moment it applies —
// there is no per-tenant setup step to send a renewal reminder), while
// `CommunicationTemplateModel` is inherently per-tenant (a `templateId`
// only resolves within that one tenant's own row). A tenant customizing
// its OWN subscription notification wording via a real, already-existing
// `CommunicationTemplateModel` row is real, buildable Adoption work on
// top of this — see `docs/05-api/09-subscription-platform-api.md`'s own
// Automation #7 section.
export const RENEWAL_REMINDER_TEMPLATES = {
  30: { subject: "Your subscription renews in 30 days", body: "Hi {{merchantName}}, your {{planCode}} subscription is scheduled to renew on {{dueDate}} for {{outstandingAmount}} {{currency}}. No action is needed if your payment method is up to date." },
  14: { subject: "Payment method reminder — renewal in 14 days", body: "Hi {{merchantName}}, your {{planCode}} subscription renews on {{dueDate}}. Please confirm your payment method is current to avoid any interruption." },
  7: { subject: "Upcoming renewal in 7 days", body: "Hi {{merchantName}}, your subscription renews on {{dueDate}} for {{outstandingAmount}} {{currency}}. {{paymentLink}}" },
  3: { subject: "Final reminder — renewal in 3 days", body: "Hi {{merchantName}}, this is a final reminder: your subscription renews on {{dueDate}} for {{outstandingAmount}} {{currency}}. {{paymentLink}}" },
  1: { subject: "Your subscription renews tomorrow", body: "Hi {{merchantName}}, your subscription renews tomorrow ({{dueDate}}) for {{outstandingAmount}} {{currency}}. {{paymentLink}}" }
};

export const PAYMENT_FAILED_TEMPLATE = {
  subject: "Payment failed for invoice {{invoiceNumber}}",
  body: "Hi {{merchantName}}, we were unable to process your payment of {{outstandingAmount}} {{currency}} for invoice {{invoiceNumber}} (attempt {{attemptNumber}}). Reason: {{reason}}. {{paymentLink}} If you need help, contact us: {{supportUrl}}"
};

export const RETRY_SCHEDULED_TEMPLATE = {
  subject: "We'll retry your payment on {{nextRetryDate}}",
  body: "Hi {{merchantName}}, we'll automatically retry your payment of {{outstandingAmount}} {{currency}} for invoice {{invoiceNumber}} on {{nextRetryDate}}. You can also pay now to avoid any delay: {{paymentLink}}"
};

export const SUSPENSION_TEMPLATE = {
  subject: "Your subscription has been suspended",
  body: "Hi {{merchantName}}, your subscription was suspended on {{suspendedAt}} because {{reason}}. Outstanding balance: {{outstandingAmount}} {{currency}}. Pay now to restore access immediately: {{paymentLink}} Need help? Contact us: {{supportUrl}}"
};

export const REACTIVATION_TEMPLATE = {
  subject: "Welcome back — your subscription is active again",
  body: "Hi {{merchantName}}, your payment was confirmed and your subscription is now Active again. Full access has been restored. Thanks for staying with us!"
};
