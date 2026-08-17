import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — User Communication Preferences Schema
 * Manages user opt-ins, preferred channels, and DND settings across the ERP platform.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CommunicationPreferenceSchema = new mongoose.Schema({
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
  emailOptIn: {
    type: Boolean,
    default: true
  },
  smsOptIn: {
    type: Boolean,
    default: true
  },
  whatsAppOptIn: {
    type: Boolean,
    default: true
  },
  pushOptIn: {
    type: Boolean,
    default: true
  },
  inAppOptIn: {
    type: Boolean,
    default: true
  },
  preferredChannel: {
    type: String,
    enum: ["Email", "SMS", "WhatsApp", "Push", "InApp"],
    default: "Email"
  },
  doNotDisturb: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

CommunicationPreferenceSchema.index({ tenantId: 1, userId: 1 }, { unique: true });

CommunicationPreferenceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationPreferenceModel = mongoose.model("communication_preference", CommunicationPreferenceSchema);

export default CommunicationPreferenceModel;
