import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — Message Delivery Schema
 * Stores message delivery lifecycle state across Email, SMS, WhatsApp, Push, InApp, and Webhook channels.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const RecipientSchema = new mongoose.Schema({
  userId: { type: String, default: null, index: true },
  email: { type: String, default: null, trim: true, lowercase: true },
  phone: { type: String, default: null, trim: true },
  pushToken: { type: String, default: null },
  endpointUrl: { type: String, default: null }
}, { _id: false });

const CommunicationMessageSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  messageId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  sourceModule: {
    type: String,
    required: true,
    // "Platform" — Enterprise Subscription Platform (a CORE platform, same
    // real module label its own AuditLogModel entries already use).
    enum: ["CRM", "Booking", "Travel", "Visa", "Finance", "HR", "Inventory", "Sales", "Procurement", "AI", "Platform", "System"],
    default: "System",
    index: true
  },
  channel: {
    type: String,
    enum: ["Email", "SMS", "WhatsApp", "Push", "InApp", "Webhook"],
    required: true,
    index: true
  },
  recipient: {
    type: RecipientSchema,
    required: true
  },
  templateId: {
    type: String,
    default: null,
    index: true
  },
  templateData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  subject: {
    type: String,
    default: null
  },
  content: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ["Requested", "Queued", "Processing", "Delivered", "Failed", "Retried", "Cancelled"],
    default: "Requested",
    index: true
  },
  priority: {
    type: String,
    enum: ["Low", "Normal", "High", "Critical"],
    default: "Normal",
    index: true
  },
  scheduledAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  deliveredAt: {
    type: Date,
    default: null
  },
  retryCount: {
    type: Number,
    default: 0
  },
  maxRetries: {
    type: Number,
    default: 3
  },
  provider: {
    type: String,
    default: null
  },
  providerResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  errorDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  idempotencyKey: {
    type: String,
    default: null,
    index: true
  },
  trackingId: {
    type: String,
    default: null,
    index: true,
    sparse: true
  },
  emailType: {
    type: String,
    enum: ["Transactional", "Marketing", "System Alert", "Password Reset", "Verification", "Invoice", "Receipt", "Reminder", "Custom"],
    default: "Transactional",
    index: true
  },
  recipients: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  attachments: [{
    filename: { type: String, required: true },
    path: { type: String, default: null },
    url: { type: String, default: null },
    contentType: { type: String, default: null },
    size: { type: Number, default: 0 }
  }],
  openCount: {
    type: Number,
    default: 0
  },
  openedAt: {
    type: Date,
    default: null
  },
  clickCount: {
    type: Number,
    default: 0
  },
  clickedAt: {
    type: Date,
    default: null
  },
  bounceStatus: {
    type: String,
    enum: ["None", "HardBounce", "SoftBounce", "SpamComplaint"],
    default: "None",
    index: true
  },
  bounceReason: {
    type: String,
    default: null
  },
  smsType: {
    type: String,
    enum: ["OTP", "Authentication", "Verification", "Invoice", "Payment Reminder", "Booking Confirmation", "Visa Update", "System Alert", "Marketing", "Custom"],
    default: "Custom",
    index: true
  },
  phone: {
    type: String,
    default: null,
    index: true
  },
  encoding: {
    type: String,
    enum: ["GSM-7", "UCS-2"],
    default: "GSM-7"
  },
  segmentCount: {
    type: Number,
    default: 1
  },
  otpId: {
    type: String,
    default: null,
    index: true
  },
  campaignId: {
    type: String,
    default: null,
    index: true
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

CommunicationMessageSchema.index({ tenantId: 1, status: 1, scheduledAt: 1 });
CommunicationMessageSchema.index({ tenantId: 1, channel: 1, createdAt: -1 });
CommunicationMessageSchema.index({ tenantId: 1, idempotencyKey: 1 }, { sparse: true });

CommunicationMessageSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationMessageModel = mongoose.model("communication_message", CommunicationMessageSchema);

export default CommunicationMessageModel;
