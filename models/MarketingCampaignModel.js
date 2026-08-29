import mongoose from "mongoose";

// Marketing Campaign System — PRD "CRM Feature Map by Phase" Phase 2 module
// 20 (part). Deliberately NOT the same model as CollectionCampaignModel.js
// (that's finance/debt-collection, targeting overdue CustomerCollectionModel
// records — a different domain entirely) and NOT a rebuild of the existing
// send infrastructure — `channel`+`templateId` compose directly onto the
// already-built CommunicationTemplateModel (channel enum matches exactly)
// and EmailPlatformService/SmsPlatformService/WhatsAppPlatformService,
// which this model only ever orchestrates, never duplicates.
const MarketingCampaignSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  channel: {
    type: String,
    enum: ["Email", "SMS", "WhatsApp"],
    required: true
  },
  // A logical CommunicationTemplateModel.templateId (not an ObjectId ref —
  // that model's own real identity is {tenantId, templateId, locale},
  // exactly like every EmailPlatformService/SmsPlatformService/
  // WhatsAppPlatformService.sendXxx({templateId}) call already expects).
  templateId: { type: String, required: true },
  // The exact filter shape POST /customers (ListCustomers) already accepts
  // — customerType, category, status, cityId, createdAfter, createdBefore —
  // stored as-submitted for audit/re-display, never re-interpreted as a raw
  // Mongo query from the client.
  segmentFilter: { type: mongoose.Schema.Types.Mixed, default: {} },
  scheduledAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ["draft", "scheduled", "sending", "sent", "cancelled"],
    default: "draft",
    index: true
  },
  // Cached at creation (segment resolved into MarketingCampaignRecipientModel
  // rows) and updated after send — avoids a recipient-collection count query
  // on every campaign list/detail read.
  recipientCount: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  sentAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

MarketingCampaignSchema.index({ tenantId: 1, status: 1 });
MarketingCampaignSchema.index({ tenantId: 1, createdAt: -1 });

MarketingCampaignSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const MarketingCampaignModel = mongoose.model("marketing_campaign", MarketingCampaignSchema);

export default MarketingCampaignModel;
