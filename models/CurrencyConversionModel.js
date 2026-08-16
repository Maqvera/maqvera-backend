import mongoose from "mongoose";

// Enterprise Multi-Currency & Foreign Exchange — Finance Module Part 19
// Part 3 (Conversion Engine, FX Accounting & Revaluation). "Conversion
// Audit Trail... Every conversion stores Conversion ID, Request Source,
// Original Amount, Converted Amount, Rate Used, Rate Provider, Rate
// Version, Calculation Method, User, Timestamp, Correlation ID. Immutable
// history maintained." Real, but deliberately OPT-IN — `CurrencyService.convert`
// only writes one of these when the caller identifies a real business
// `source` (see its own doc comment); this codebase's own internal
// conversion calls (revaluation loops, FX exposure recalculation, etc.)
// stay lightweight and are never logged here, so this table records real
// business transactions, not implementation-detail noise. Tenant-scoped
// only — no branchId.
const CurrencyConversionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Config-driven (conversionSources) — Sales Invoice, Purchase Invoice,
  // Customer Payment, Vendor Payment, Expense, Payroll, Asset Purchase,
  // Asset Disposal, Journal Entry, Budget, Subscription Billing,
  // Membership Renewal, Marketplace Order, Treasury Transfer, Bank
  // Transaction, Custom.
  conversionSource: { type: String, required: true, index: true },
  sourceReferenceId: { type: mongoose.Schema.Types.Mixed, default: null },
  originalAmount: { type: Number, required: true },
  originalCurrency: { type: String, required: true },
  convertedAmount: { type: Number, required: true },
  convertedCurrency: { type: String, required: true },
  rate: { type: Number, required: true },
  rateId: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
  rateType: { type: String, default: null },
  rateProvider: { type: String, default: null },
  rateVersion: { type: Number, default: null },
  // Direct | Inverse | Triangulated — CurrencyService.getRate's own three
  // real resolution paths, never a fabricated fourth.
  calculationMethod: { type: String, required: true },
  correlationId: { type: String, default: null },
  performedBy: { type: String, default: null }
}, { timestamps: true });

CurrencyConversionSchema.index({ tenantId: 1, conversionSource: 1, createdAt: -1 });
CurrencyConversionSchema.index({ tenantId: 1, correlationId: 1 });

CurrencyConversionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CurrencyConversionModel = mongoose.model("currency_conversion", CurrencyConversionSchema);

export default CurrencyConversionModel;
