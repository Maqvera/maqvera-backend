import mongoose from "mongoose";

/**
 * Gap 1.1 "Notification delivery is a dead end" — durable record of every
 * delivery attempt NotificationDeliveryService makes, so a failure or an
 * honestly-unresolvable recipient is visible (queryable), never silent.
 * `tenantId` is nullable on purpose: two real, pre-existing publish sites
 * (CustomerController's welcome_customer, UserController's invitation_email)
 * never carried a tenantId in their payload at all.
 */
const NotificationLogSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  // Which of the three global event names triggered this attempt.
  sourceEvent: { type: String, required: true, index: true },
  // payload.event (or payload.type for the two legacy shapes above), e.g. "AIAlertTriggered".
  event: { type: String, default: null, index: true },
  channel: { type: String, required: true },
  recipient: { type: String, default: null },
  // How the recipient was resolved — "payload.email" | "recipientId" | "tenantAdmin" | null when unresolved. Debugging/audit aid, not a business field.
  recipientSource: { type: String, default: null },
  status: { type: String, enum: ["Sent", "Failed", "NotConfigured", "Skipped"], required: true, index: true },
  providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
  failureReason: { type: String, default: null },
  // Small, non-exhaustive context subset (ids only, never the full payload) for tracing back to the source record.
  context: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

NotificationLogSchema.index({ tenantId: 1, createdAt: -1 });

const NotificationLogModel = mongoose.model("notification_log", NotificationLogSchema);

export default NotificationLogModel;
