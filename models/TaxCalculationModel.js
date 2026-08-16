import mongoose from "mongoose";

// Enterprise Tax Engine — Finance Module Part 20. "Transaction Storage...
// Stores Transaction Currency, Base Currency, Exchange Rate, Converted
// Amount, Rate Source, Historical Snapshot. Immutable after posting" —
// Part 19's own discipline, applied here to tax: every real
// `POST /api/v1/tax/calculate` (and `/tax/withholding/calculate`) call
// persists one immutable row, the real source Tax Reporting aggregates
// from. Never edited after creation. Tenant-scoped only — no branchId.
const TaxCalculationLineSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  taxCode: { type: String, default: null },
  taxRuleId: { type: mongoose.Schema.Types.ObjectId, ref: "tax_rule", default: null },
  // Denormalized from the resolved rule at calculation time (not
  // re-derived later) — so TaxService.generateTaxReport can group/filter
  // by taxType without re-resolving every line's own taxRuleId.
  taxType: { type: String, default: null },
  taxRate: { type: Number, default: 0 },
  taxBasis: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  exempted: { type: Boolean, default: false },
  exemptionId: { type: mongoose.Schema.Types.ObjectId, ref: "tax_exemption", default: null },
  reverseCharge: { type: Boolean, default: false }
}, { _id: false });

const TaxCalculationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Invoice | Payment | CreditNote | DebitNote | Withholding | Custom —
  // caller-declared, drives `direction` below for reporting.
  transactionType: { type: String, required: true, index: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  transactionRef: { type: String, default: null },
  // Output (sales-side tax collected from a customer) | Input
  // (purchase-side tax paid to a vendor, or withholding deducted from a
  // payment) — the real signal Tax Reporting nets against
  // (netPayable = output - input), derived from `transactionType`, not
  // caller-supplied.
  direction: { type: String, required: true },
  jurisdiction: {
    country: { type: String, required: true },
    state: { type: String, default: null }
  },
  currency: { type: String, required: true },
  lines: { type: [TaxCalculationLineSchema], default: [] },
  documentTaxTotal: { type: Number, required: true },
  calculatedAt: { type: Date, default: Date.now },
  performedBy: { type: String, default: null }
}, { timestamps: true });

TaxCalculationSchema.index({ tenantId: 1, calculatedAt: -1 });
TaxCalculationSchema.index({ tenantId: 1, "jurisdiction.country": 1, calculatedAt: -1 });

TaxCalculationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TaxCalculationModel = mongoose.model("tax_calculation", TaxCalculationSchema);

export default TaxCalculationModel;
