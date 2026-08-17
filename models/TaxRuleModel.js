import mongoose from "mongoose";

// Enterprise Tax Engine — Finance Module Part 20. "A real ERP never
// hardcodes tax logic. It uses a centralized Tax Engine." The real,
// versioned, effective-dated tax rule registry — one row per
// (taxCode, country[, state], effectiveDate) version, never edited after
// creation ("Immutable Tax History"): a rate correction is a NEW row,
// with the prior row's own `endDate`/`status` closed out by
// TaxService.createTaxRule's real auto-supersede logic. Tenant-scoped
// only — no branchId.
const TaxRuleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  taxCode: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (taxTypes) — VAT, GST, SalesTax, ServiceTax,
  // WithholdingTax, ImportTax, ExportTax, LuxuryTax, EnvironmentalTax,
  // Custom.
  taxType: { type: String, required: true, index: true },
  // "Jurisdiction Rules... Country, State, Province..." — country is the
  // real, required jurisdiction key this pass; `state` is an optional
  // refinement for country regimes that need it (e.g. USA state tax).
  // County/City/PostalCode/BusinessZone have no concrete resolution
  // requirement given anywhere in this Part's own endpoint contracts
  // (only `customerCountry` is ever supplied to POST /tax/calculate) —
  // honestly not implemented rather than guessed at.
  country: { type: String, required: true, uppercase: true, trim: true, index: true },
  state: { type: String, default: null, trim: true },
  rate: { type: Number, required: true, min: 0 },
  // Config-driven (taxCalculationMethods) — Exclusive, Inclusive,
  // Compound.
  calculationMethod: { type: String, required: true },
  // "Compound Tax, Cascading Tax" — the OTHER taxCode(s) (same tenant/
  // country) this rule's own base amount already includes when
  // `calculationMethod` is Compound — e.g. Canada's PST compounding on a
  // GST-inclusive base. Empty for a rule that taxes the plain line
  // amount.
  compoundOnTaxCodes: { type: [String], default: [] },
  minTaxAmount: { type: Number, default: null },
  maxTaxAmount: { type: Number, default: null },
  // "Reverse Charge... Domestic, International, B2B, B2C." Empty =
  // reverse charge never applies to this rule.
  reverseChargeScopes: { type: [String], default: [] },
  // "Withholding Tax... Supplier Payments, Professional Services,
  // Contractors, Dividends, Interest." Only meaningful when
  // taxType === 'WithholdingTax'.
  withholdingCategory: { type: String, default: null },
  effectiveDate: { type: Date, required: true, index: true },
  // null = open-ended (still the current version). Set automatically by
  // TaxService.createTaxRule when a newer version for the same
  // (taxCode, country, state) is created, or manually via expire.
  endDate: { type: Date, default: null },
  // Config-driven (taxRuleStatuses) — Draft, Approved, Expired, Archived,
  // Superseded. See utils/financeConfig.js's own doc comment for why
  // "Reviewed"/"Effective"/"Active" aren't separate resting states here.
  status: { type: String, required: true, index: true },
  // The prior version this rule replaced, when it was created as an
  // explicit correction/new version rather than a brand-new tax code.
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "tax_rule", default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

TaxRuleSchema.index({ tenantId: 1, taxCode: 1, country: 1, state: 1, effectiveDate: -1 });
TaxRuleSchema.index({ tenantId: 1, status: 1, endDate: 1 });

TaxRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TaxRuleModel = mongoose.model("tax_rule", TaxRuleSchema);

export default TaxRuleModel;
