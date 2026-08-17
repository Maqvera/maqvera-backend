import mongoose from "mongoose";

// Enterprise Multi-Currency & Foreign Exchange — Finance Module Part 19.
// "Historical Rate Preservation... Immutable Posted Rates." A correction
// is a NEW row with a later `importedAt`, never an edit to an existing
// one — CurrencyService exposes no update/delete for this model at all.
// Tenant-scoped only — no branchId.
const ExchangeRateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  fromCurrency: { type: String, required: true, uppercase: true },
  toCurrency: { type: String, required: true, uppercase: true },
  rate: { type: Number, required: true, min: 0 },
  // Config-driven (exchangeRateTypes) — Spot, Historical, Average,
  // MonthEnd, Custom.
  rateType: { type: String, required: true, index: true },
  // Config-driven (rateProviders) — CentralBank, CommercialBank,
  // OpenExchangeAPI, Manual, Custom.
  provider: { type: String, required: true },
  // Manual (a human typed it in) | Automatic (services/CurrencyService.js
  // importRatesFromProvider — a real provider API call).
  source: { type: String, required: true },
  // The date this rate is EFFECTIVE for/represents — not necessarily
  // "today". ConversionEngine lookups pick the latest row with
  // effectiveDate <= the requested as-of date, never a future one.
  effectiveDate: { type: Date, required: true, index: true },
  // File 4 Part 2 — real, optional expiry. `CurrencyService.getRate`
  // excludes an expired row from live conversion the same way it already
  // excludes a future-dated one.
  expiresAt: { type: Date, default: null },
  // "Every rate change creates New Version, Previous Version Preserved."
  // A real, per (tenant, fromCurrency, toCurrency, rateType) counter —
  // `CurrencyService.createExchangeRate` computes it, never the caller.
  version: { type: Number, default: 1 },
  // Config-driven (exchangeRateApprovalStatuses) — Draft, Pending
  // Approval, Activated, Rejected, Expired, Archived, Superseded. Unset
  // on rows created before this Part existed — `CurrencyService.getRate`
  // treats that the same as "Activated" (real backward compatibility, see
  // its own doc comment).
  approvalStatus: { type: String, default: null },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  // "No Overlapping Active Version" — creating a new rate for the same
  // exact (fromCurrency, toCurrency, rateType) auto-supersedes whichever
  // row was previously the current Activated one for that combination
  // (its own `approvalStatus` flips to "Superseded", never edited/deleted
  // otherwise) rather than allowing two simultaneously-current rows.
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
  correlationId: { type: String, default: null },
  createdBy: { type: String, default: null }
}, {
  timestamps: true,
  // "Support optimistic locking." (File 7 Part 5) — real for the
  // findOne-then-.save() paths (`_activateExchangeRateRow`/
  // `rejectExchangeRate`). One honest exception: the row being superseded
  // is flipped via a raw `ExchangeRateModel.updateOne` (never re-fetched
  // as a document to `.save()`), which does not participate in Mongoose's
  // version check either way — same as before this flag was added, not a
  // new gap introduced by it.
  optimisticConcurrency: true
});

ExchangeRateSchema.index({ tenantId: 1, fromCurrency: 1, toCurrency: 1, rateType: 1, effectiveDate: -1 });
ExchangeRateSchema.index({ tenantId: 1, approvalStatus: 1 });
ExchangeRateSchema.index({ tenantId: 1, fromCurrency: 1, toCurrency: 1, rateType: 1, version: -1 });

ExchangeRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ExchangeRateModel = mongoose.model("exchange_rate", ExchangeRateSchema);

export default ExchangeRateModel;
