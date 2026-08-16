import mongoose from "mongoose";

/**
 * Enterprise SMS Platform — Bulk SMS Campaign Schema
 * Supports batch processing, recipient list management, delivery statistics, and pause/resume lifecycle.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CampaignRecipientSchema = new mongoose.Schema({
  phone: { type: String, required: true, trim: true },
  trackingId: { type: String, default: null },
  status: {
    type: String,
    enum: ["Pending", "Queued", "Sent", "Delivered", "Failed"],
    default: "Pending"
  },
  failureReason: { type: String, default: null }
}, { _id: false });

const SmsCampaignSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  campaignId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  smsType: {
    type: String,
    enum: ["Marketing", "Invoice", "Payment Reminder", "Booking Confirmation", "Visa Update", "System Alert", "Custom"],
    default: "Marketing",
    index: true
  },
  templateId: {
    type: String,
    default: null
  },
  templateVariables: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  messageText: {
    type: String,
    default: null
  },
  recipients: [CampaignRecipientSchema],
  totalRecipients: {
    type: Number,
    default: 0
  },
  sentCount: {
    type: Number,
    default: 0
  },
  deliveredCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ["Draft", "Scheduled", "Processing", "Paused", "Completed", "Failed", "Cancelled"],
    default: "Draft",
    index: true
  },
  rateLimitPerSecond: {
    type: Number,
    default: 50
  },
  scheduledAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

SmsCampaignSchema.index({ tenantId: 1, status: 1, scheduledAt: 1 });

SmsCampaignSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SmsCampaignModel = mongoose.model("sms_campaign", SmsCampaignSchema);

export default SmsCampaignModel;
