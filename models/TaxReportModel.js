import mongoose from "mongoose";

// Enterprise Tax Engine — Finance Module Part 20. "Tax Reporting... VAT
// Return, GST Return, Sales Tax Return, Withholding Return, Country
// Specific Reports." A real, immutable, generated-report snapshot — the
// aggregation TaxService.generateTaxReport performs against
// TaxCalculationModel is re-runnable at any time, but a filed/submitted
// period's own figures shouldn't silently drift if new transactions land
// after the fact, so each generation is its own persisted, timestamped
// row. Tenant-scoped only — no branchId.
const TaxReportLineSchema = new mongoose.Schema({
  taxCode: { type: String, required: true },
  taxType: { type: String, default: null },
  outputTax: { type: Number, default: 0 },
  inputTax: { type: Number, default: 0 },
  netPayable: { type: Number, default: 0 },
  transactionCount: { type: Number, default: 0 }
}, { _id: false });

const TaxReportSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // VATReturn | GSTReturn | SalesTaxReturn | WithholdingReturn | Custom.
  reportType: { type: String, required: true, index: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  country: { type: String, default: null },
  currency: { type: String, required: true },
  lines: { type: [TaxReportLineSchema], default: [] },
  totalOutputTax: { type: Number, default: 0 },
  totalInputTax: { type: Number, default: 0 },
  totalNetPayable: { type: Number, default: 0 },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, default: null }
}, { timestamps: true });

TaxReportSchema.index({ tenantId: 1, reportType: 1, periodStart: -1 });

TaxReportSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TaxReportModel = mongoose.model("tax_report", TaxReportSchema);

export default TaxReportModel;
