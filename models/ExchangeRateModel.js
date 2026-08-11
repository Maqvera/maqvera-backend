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
  createdBy: { type: String, default: null }
}, { timestamps: true });

ExchangeRateSchema.index({ tenantId: 1, fromCurrency: 1, toCurrency: 1, rateType: 1, effectiveDate: -1 });

ExchangeRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ExchangeRateModel = mongoose.model("exchange_rate", ExchangeRateSchema);

export default ExchangeRateModel;
