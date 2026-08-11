import mongoose from "mongoose";

// Enterprise Multi-Currency & Foreign Exchange — Finance Module Part 19.
// "Currency Revaluation... FX Gain/Loss... Automatic period-end
// revaluation." One row per (target record, revaluation run) — each new
// revaluation's `previousBaseAmount` is the prior revaluation's own
// `currentBaseAmount` (a rolling baseline, real period-over-period
// comparison, not always re-measured against the original booking date).
// Tenant-scoped only — no branchId.
const CurrencyRevaluationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  revaluationDate: { type: Date, required: true, index: true },
  // Config-driven (fxRevaluationTargets) — BankAccount, AccountsReceivable,
  // AccountsPayable.
  targetType: { type: String, required: true, index: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  currencyCode: { type: String, required: true },
  baseCurrencyCode: { type: String, required: true },
  foreignAmount: { type: Number, required: true },
  previousBaseAmount: { type: Number, required: true },
  currentBaseAmount: { type: Number, required: true },
  rateUsed: { type: Number, required: true },
  rateId: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
  gainLossAmount: { type: Number, required: true },
  // Unrealized Gain | Unrealized Loss | null (no movement this run).
  // Revaluation always produces the "Unrealized" pair — a "Realized"
  // gain/loss is calculated at actual settlement instead (see
  // CurrencyService.calculateGainLoss's own doc comment for the
  // distinction), never written to this model.
  gainLossType: { type: String, default: null },
  journalId: { type: mongoose.Schema.Types.ObjectId, ref: "journal", default: null },
  performedBy: { type: String, default: null }
}, { timestamps: true });

CurrencyRevaluationSchema.index({ tenantId: 1, targetType: 1, targetId: 1, revaluationDate: -1 });

CurrencyRevaluationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CurrencyRevaluationModel = mongoose.model("currency_revaluation", CurrencyRevaluationSchema);

export default CurrencyRevaluationModel;
