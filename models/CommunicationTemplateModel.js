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
    unique: true,
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
  status: {
    type: String,
    enum: ["Draft", "Active", "Archived"],
    default: "Active",
    index: true
  },
  version: {
    type: Number,
    default: 1
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

CommunicationTemplateSchema.index({ tenantId: 1, channel: 1, status: 1 });

CommunicationTemplateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationTemplateModel = mongoose.model("communication_template", CommunicationTemplateSchema);

export default CommunicationTemplateModel;
