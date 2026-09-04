import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — Template Schema
 * Centralized message templates across Email, SMS, WhatsApp, Push, InApp, and Webhook channels.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CommunicationTemplateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  templateId: {
    type: String,
    required: true,
    index: true
  },
  // Part 8 fix — one logical template (identified by templateId) can now
  // have several locale variants, each its own document; templateId is no
  // longer globally unique on its own — see the compound index below.
  locale: {
    type: String,
    default: "en",
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  channel: {
    type: String,
    enum: ["Email", "SMS", "WhatsApp", "Push", "InApp", "Webhook"],
    required: true,
    index: true
  },
  subjectTemplate: {
    type: String,
    default: ""
  },
  bodyTemplate: {
    type: String,
    required: true
  },
  variables: {
    type: [String],
    default: []
  },
  // Part 8 fix — real approval gate: Draft -> PendingApproval -> Active
  // (live/sendable) or Rejected (kicked back to Draft for edits), then
  // Archived when retired. A template can no longer reach "Active" through
  // a plain field update — only CommunicationTemplateService.approveTemplate()
  // sets it (see that method's own doc comment for why).
  status: {
    type: String,
    enum: ["Draft", "PendingApproval", "Active", "Rejected", "Archived"],
    default: "Draft",
    index: true
  },
  version: {
    type: Number,
    default: 1
  },
  createdBy: {
    type: String,
    default: null
  },
  submittedBy: {
    type: String,
    default: null
  },
  submittedAt: {
    type: Date,
    default: null
  },
  approvedBy: {
    type: String,
    default: null
  },
  approvedAt: {
    type: Date,
    default: null
  },
  rejectedBy: {
    type: String,
    default: null
  },
  rejectionReason: {
    type: String,
    default: null
  }
}, { timestamps: true });

CommunicationTemplateSchema.index({ tenantId: 1, templateId: 1, locale: 1 }, { unique: true });
CommunicationTemplateSchema.index({ tenantId: 1, channel: 1, status: 1 });

CommunicationTemplateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationTemplateModel = mongoose.model("communication_template", CommunicationTemplateSchema);

export default CommunicationTemplateModel;
