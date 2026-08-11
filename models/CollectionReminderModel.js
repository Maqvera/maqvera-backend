import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18. "Reminder
// Engine... Email, SMS, WhatsApp, Push Notification, Customer Portal.
// Configurable Schedule." The real, per-send log this Part was missing
// closes: `services/receivableOverdueScheduler.js` (Part 5) has published
// `NotificationRequested` for every collection escalation since Part 5
// shipped, but no listener anywhere ever consumed it — real delivery
// through `services/delivery/` (Part 8's adapters) plus a durable record
// of what was actually attempted starts here, not by touching that
// already-shipped scheduler file. Tenant-scoped only — no branchId.
const CollectionReminderSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Nullable — a manual reminder (POST .../send-reminder) always has one;
  // an Escalation reminder consumed straight off AR's own
  // `NotificationRequested` (published for every receivable, whether or
  // not that receivable was ever pulled into a formal Customer Payments
  // collection request) may not have a matching collection at all. Real
  // delivery still happens either way — `receivableId`/`customerId` below
  // are always populated so the send is traceable without one.
  collectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer_collection",
    default: null,
    index: true
  },
  receivableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "accounts_receivable",
    default: null
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  // Email | SMS | WhatsApp | Webhook — the channels with a real adapter
  // (services/delivery/index.js). Push Notification/Customer Portal are
  // still accepted and recorded as NotConfigured, never silently dropped.
  channel: { type: String, required: true },
  recipientAddress: { type: String, default: null },
  // Sent | Failed | NotConfigured — mirrors BaseDeliveryAdapter's own
  // contract exactly (services/delivery/BaseDeliveryAdapter.js).
  status: { type: String, required: true },
  providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
  failureReason: { type: String, default: null },
  // Manual | Scheduled | Escalation — Manual for POST .../send-reminder,
  // Scheduled for the plain due-date reminder cadence, Escalation for a
  // NotificationRequested event consumed from the AR collection-stage
  // ladder (utils/financeConfig.js collectionStages).
  triggeredBy: { type: String, required: true },
  collectionStage: { type: String, default: null },
  sentAt: { type: Date, default: Date.now }
}, { timestamps: true });

CollectionReminderSchema.index({ tenantId: 1, collectionId: 1, sentAt: -1 });

CollectionReminderSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CollectionReminderModel = mongoose.model("collection_reminder", CollectionReminderSchema);

export default CollectionReminderModel;
