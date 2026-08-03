import mongoose from "mongoose";

// Read model for customer-specific dashboard requests.  It deliberately keeps
// customer dashboard reads away from operational Visa and Appointment tables.
const VisaCustomerAnalyticsSummarySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  branchId: { type: String, required: true, default: "main", index: true },
  customerId: { type: String, required: true, index: true },
  summaryDate: { type: String, required: true, index: true },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  generatedAt: { type: Date, default: Date.now },
  lastRefreshedAt: { type: Date, default: Date.now },
  source: { type: String, default: "event-driven-kpi-engine" },
}, { timestamps: true });

VisaCustomerAnalyticsSummarySchema.index(
  { tenantId: 1, branchId: 1, customerId: 1, summaryDate: 1 },
  { unique: true }
);

export default mongoose.model("visa_customer_analytics_summary", VisaCustomerAnalyticsSummarySchema);
