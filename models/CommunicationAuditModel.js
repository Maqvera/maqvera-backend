import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — Audit Log Schema
 * Immutable recording of all messaging state transitions, domain events, and delivery attempts.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CommunicationAuditSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  auditId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  messageId: {
    type: String,
    required: true,
    index: true
  },
  event: {
    type: String,
    enum: [
      "CommunicationRequested",
      "CommunicationQueued",
      "CommunicationDelivered",
      "CommunicationFailed",
      "CommunicationRetried",
      "CommunicationCancelled",
      "ProviderUnavailable"
    ],
    required: true,
    index: true
  },
  channel: {
    type: String,
    required: true
  },
  provider: {
    type: String,
    default: null
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Part 15 fix — same Enterprise Data Retention & Legal Hold Standard
  // fields every other archivable record in this codebase carries
  // (mirrors Finance's own AuditEventModel, already wired to
  // auditRetentionScheduler.js's identical lifecycle).
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: String, default: null },
  archiveReason: { type: String, default: null },
  purgeEligibleAt: { type: Date, default: null, index: true },
  retentionPolicy: { type: String, default: null },
  restoredAt: { type: Date, default: null },
  restoredBy: { type: String, default: null },
  legalHold: { type: Boolean, default: false, index: true },
  legalHoldReason: { type: String, default: null }
}, { timestamps: true });

CommunicationAuditSchema.index({ tenantId: 1, messageId: 1, createdAt: -1 });

CommunicationAuditSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationAuditModel = mongoose.model("communication_audit", CommunicationAuditSchema);

export default CommunicationAuditModel;
