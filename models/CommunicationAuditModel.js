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
  }
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
