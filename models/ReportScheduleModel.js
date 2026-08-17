import mongoose from "mongoose";

// Enterprise Financial Reporting — Finance Module Part 24. "Report
// Scheduling... Daily, Weekly, Monthly, Quarterly, Yearly." A real,
// cron-driven recurring generation + delivery definition — real delivery
// reuses Part 8's own `services/delivery/EmailDeliveryAdapter.js`
// directly. Tenant-scoped only — no branchId.
const ReportScheduleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true },
  // Config-driven (reportTypes).
  reportType: { type: String, required: true },
  // The fixed parameters re-used every run (currency, account scope,
  // etc.) — `periodStart`/`periodEnd`/`asOfDate` are recomputed fresh
  // each run relative to the schedule's own frequency, never replayed
  // from a stale stored date.
  parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Config-driven (reportScheduleFrequencies) — Daily, Weekly, Monthly,
  // Quarterly, Yearly.
  frequency: { type: String, required: true },
  recipientEmails: { type: [String], default: [] },
  // Config-driven (reportExportFormats) — the format attached to the
  // scheduled email.
  format: { type: String, required: true },
  nextRunAt: { type: Date, required: true },
  lastRunAt: { type: Date, default: null },
  // Active | Paused | Cancelled.
  status: { type: String, required: true, default: "Active" },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ReportScheduleSchema.index({ tenantId: 1, status: 1, nextRunAt: 1 });

ReportScheduleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReportScheduleModel = mongoose.model("report_schedule", ReportScheduleSchema);

export default ReportScheduleModel;
