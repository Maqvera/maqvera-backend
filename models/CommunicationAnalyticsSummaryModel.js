import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — Analytics Summary Schema (Part 14).
 * Mirrors FinanceOperationsSummaryModel's own proven shape exactly: one
 * persisted read-model row per (tenant, day), refreshed by
 * CommunicationAnalyticsEngine on relevant domain events and a scheduled
 * sweep — dashboards read this, never the live CommunicationMessageModel
 * collection on every hit.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CommunicationAnalyticsSummarySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // YYYY-MM-DD — same day-keyed convention as FinanceOperationsSummaryModel,
  // so a trend snapshot across days is a cheap range query, not a re-aggregation.
  summaryDate: {
    type: String,
    required: true,
    index: true
  },
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  generatedAt: {
    type: Date,
    default: null
  },
  lastRefreshedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

CommunicationAnalyticsSummarySchema.index({ tenantId: 1, summaryDate: 1 }, { unique: true });

CommunicationAnalyticsSummarySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationAnalyticsSummaryModel = mongoose.model("communication_analytics_summary", CommunicationAnalyticsSummarySchema);

export default CommunicationAnalyticsSummaryModel;
