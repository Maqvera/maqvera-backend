import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — Consent/Preference Change History Schema
 * Immutable record of every change to a user's CommunicationPreferenceModel document.
 * CommunicationPreferenceService previously overwrote preferences via findOneAndUpdate
 * with no history — this is what makes "prove the user consented/withdrew on this date"
 * answerable (GDPR/CCPA-relevant).
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CommunicationConsentHistorySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  changes: {
    type: [{
      field: { type: String, required: true },
      oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
      newValue: { type: mongoose.Schema.Types.Mixed, default: null },
      _id: false
    }],
    default: []
  },
  actorUserId: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { timestamps: true });

CommunicationConsentHistorySchema.index({ tenantId: 1, userId: 1, createdAt: -1 });

CommunicationConsentHistorySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationConsentHistoryModel = mongoose.model("communication_consent_history", CommunicationConsentHistorySchema);

export default CommunicationConsentHistoryModel;
