import mongoose from "mongoose";

// Enterprise Customer Payments — Finance Module Part 18 Part 4 (Enterprise
// Collection Features). "Collection Campaigns... High Value Customers,
// Overdue Customers, Subscription Renewals, Membership Renewals,
// Regional, Seasonal, Risk-Based, Custom." `targetCriteria` is a real,
// Mongo-queryable filter (CollectionCampaignService builds an actual
// `CustomerCollectionModel.find()` from it) — a campaign's targets are
// never a canned/fabricated customer segment. Tenant-scoped only — no
// branchId.
const CollectionCampaignSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  campaignNumber: {
    type: String,
    required: true,
    immutable: true
  },
  name: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (collectionCampaignTypes) — purely descriptive/reporting
  // categorization; `targetCriteria` below is what actually selects
  // collections.
  campaignType: { type: String, required: true, index: true },
  // Config-driven (collectionCampaignStatuses) — Draft, Active, Completed,
  // Cancelled.
  status: { type: String, required: true, index: true },
  // Real query criteria — every key here maps directly onto a real
  // CustomerCollectionModel field.
  targetCriteria: {
    status: { type: String, default: null },
    collectionSource: { type: String, default: null },
    currency: { type: String, default: null },
    minAmount: { type: Number, default: null },
    maxAmount: { type: Number, default: null },
    minDaysOverdue: { type: Number, default: null },
    collectionStage: { type: String, default: null }
  },
  // Config-driven (deliveryMethods) — which real channel `runCampaign`
  // sends through (reuses CustomerCollectionService.sendReminder's own
  // real adapters, not a parallel messaging path).
  reminderChannel: { type: String, default: "Email" },
  targetedCollectionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "customer_collection" }],
  results: {
    targetedCount: { type: Number, default: 0 },
    remindersSent: { type: Number, default: 0 },
    remindersFailed: { type: Number, default: 0 },
    totalOutstandingAmount: { type: Number, default: 0 }
  },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

CollectionCampaignSchema.index({ tenantId: 1, campaignNumber: 1 }, { unique: true });
CollectionCampaignSchema.index({ tenantId: 1, status: 1 });

CollectionCampaignSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CollectionCampaignModel = mongoose.model("collection_campaign", CollectionCampaignSchema);

export default CollectionCampaignModel;
