import mongoose from "mongoose";

// Enterprise Multi-Currency & Foreign Exchange — Finance Module Part 19.
// The tenant's own currency registry — which currencies it actually deals
// in, and which one is its "Company Base Currency" (exactly one per
// tenant, enforced in CurrencyService, never structurally by a unique
// index since Mongoose has no partial-unique-on-boolean shorthand across
// drivers this codebase targets). Tenant-scoped only — no branchId.
const CurrencySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Real ISO 4217 alphabetic code (utils/iso4217.js), always uppercase.
  currencyCode: {
    type: String,
    required: true,
    uppercase: true
  },
  name: { type: String, required: true },
  symbol: { type: String, default: null },
  decimalPlaces: { type: Number, default: 2, min: 0, max: 4 },
  // "Company Base Currency" — every conversion in this module resolves
  // relative to whichever currency has this flag set for the tenant. Only
  // one may be true at a time; CurrencyService.createCurrency/setBaseCurrency
  // unset any prior holder before setting a new one.
  isBaseCurrency: { type: Boolean, default: false, index: true },
  // Config-driven (currencyStatuses) — Draft, Active, Suspended, Archived.
  // See utils/financeConfig.js's own doc comment for why "Rate
  // Imported"/"Validated"/"Used" aren't separate resting states here.
  status: {
    type: String,
    required: true,
    index: true
  },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CurrencySchema.index({ tenantId: 1, currencyCode: 1 }, { unique: true });
CurrencySchema.index({ tenantId: 1, status: 1 });

CurrencySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CurrencyModel = mongoose.model("currency", CurrencySchema);

export default CurrencyModel;
