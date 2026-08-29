import mongoose from "mongoose";

// One row per customer a MarketingCampaign's segment resolved to at
// creation time — a snapshot, not a live re-query, so `GET
// /campaigns/:id/analytics` and the send loop both operate on a stable
// list even if the customer segment would resolve differently later
// (matches this codebase's own "freeze at creation" convention, e.g.
// QuotationModel.snapshotData).
const MarketingCampaignRecipientSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "marketing_campaign", required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", required: true },
  status: {
    type: String,
    enum: ["pending", "sent", "delivered", "opened", "clicked", "failed"],
    default: "pending",
    index: true
  },
  trackingId: { type: String, default: null },
  error: { type: String, default: null },
  sentAt: { type: Date, default: null }
}, { timestamps: true });

MarketingCampaignRecipientSchema.index({ tenantId: 1, campaignId: 1, customerId: 1 }, { unique: true });
MarketingCampaignRecipientSchema.index({ tenantId: 1, campaignId: 1, status: 1 });

MarketingCampaignRecipientSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const MarketingCampaignRecipientModel = mongoose.model("marketing_campaign_recipient", MarketingCampaignRecipientSchema);

export default MarketingCampaignRecipientModel;
