import mongoose from "mongoose";

const TravelTimelineSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  travelPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_plan",
    required: false,
    default: null,
    index: true
  },
  visaCaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "visa_case",
    default: null,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    required: true,
    default: "main",
    index: true
  },
  sourceModule: {
    type: String,
    default: "VisaManagement",
    index: true
  },
  aggregateType: {
    type: String,
    default: "VisaCase"
  },
  aggregateId: {
    type: String,
    default: null
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  eventVersion: {
    type: String,
    default: "1.0.0"
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  actor: {
    userId: { type: String, default: null },
    name: { type: String, default: "System" },
    role: { type: String, default: "System" }
  },
  visibility: {
    type: String,
    enum: ["Public", "Internal", "Operations", "Management", "Customer Visible", "Private", "System"],
    default: "Internal",
    index: true
  },
  correlationId: {
    type: String,
    default: null,
    index: true
  },
  causationId: {
    type: String,
    default: null
  },
  attachments: [
    {
      name: { type: String, required: true },
      url: { type: String, required: true },
      mimeType: { type: String, default: "application/pdf" },
      size: { type: Number, default: 0 },
      uploadedAt: { type: Date, default: Date.now }
    }
  ],
  comments: [
    {
      commentId: { type: String, required: true },
      authorId: { type: String, default: null },
      authorName: { type: String, default: "Staff" },
      text: { type: String, required: true },
      createdAt: { type: Date, default: Date.now }
    }
  ],
  mentions: [
    {
      type: String
    }
  ],
  aiConfidenceScore: {
    type: Number,
    default: null
  },
  isImmutable: {
    type: Boolean,
    default: true
  },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: String, default: null },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

TravelTimelineSchema.index({ visaCaseId: 1, tenantId: 1, createdAt: -1 });
TravelTimelineSchema.index({ visaCaseId: 1, tenantId: 1, branchId: 1, createdAt: -1 });
TravelTimelineSchema.index({ travelPlanId: 1, tenantId: 1, createdAt: -1 });
TravelTimelineSchema.index({ tenantId: 1, eventType: 1, sourceModule: 1 });
TravelTimelineSchema.index({ title: "text", description: "text" });

const TravelTimelineModel = mongoose.model("travel_timeline", TravelTimelineSchema);

export default TravelTimelineModel;
