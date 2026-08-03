import mongoose from "mongoose";

// Read model for GET /customers/{id}/statistics ("Statistics are generated
// from summary tables. Never calculate directly from millions of
// transactional records.", Part 5). Refreshed asynchronously by
// CustomerStatisticsEngine in reaction to Booking domain events — never
// computed synchronously inside a customer-facing request.
const CustomerStatisticsSummarySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  branchId: { type: String, default: null, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", required: true, index: true },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  generatedAt: { type: Date, default: Date.now },
  lastRefreshedAt: { type: Date, default: Date.now },
  source: { type: String, default: "event-driven-customer-statistics-engine" }
}, { timestamps: true });

CustomerStatisticsSummarySchema.index({ tenantId: 1, customerId: 1 }, { unique: true });

export default mongoose.model("customer_statistics_summary", CustomerStatisticsSummarySchema);
