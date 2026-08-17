import mongoose from "mongoose";

// Enterprise Discount & Pricing Engine — Finance Module Part 21. The
// real, versioned, effective-dated pricing/discount rule registry —
// mirrors Part 20's own TaxRuleModel design exactly (one row per
// version, immutable after creation, auto-superseded by a newer
// overlapping version). One flexible model covers every rule TYPE the
// spec names (CustomerSpecific/Contract/Volume/Promotion/Loyalty) via
// `ruleType`, the same "one model, a type field" pattern TaxRuleModel
// already used for VAT/GST/WithholdingTax/etc. Tenant-scoped only — no
// branchId.
const VolumeTierSchema = new mongoose.Schema({
  minQuantity: { type: Number, required: true, min: 0 },
  discountType: { type: String, required: true },
  discountValue: { type: Number, required: true, min: 0 }
}, { _id: false });

const PricingRuleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  ruleName: { type: String, required: true },
  description: { type: String, default: null },
  // Config-driven (pricingRuleTypes) — CustomerSpecific, Contract,
  // Volume, Promotion, Loyalty.
  ruleType: { type: String, required: true, index: true },
  // Config-driven (promotionTypes) — only meaningful when
  // ruleType === 'Promotion'.
  promotionType: { type: String, default: null },
  // Narrows who this rule applies to — any combination may be set;
  // PricingService.resolveApplicableRules requires ALL set fields to
  // match (an empty/null field means "no restriction on this
  // dimension").
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", default: null, index: true },
  customerGroup: { type: String, default: null },
  productCode: { type: String, default: null, uppercase: true, trim: true },
  // Config-driven (discountTypes) — Percentage, FixedAmount, BuyXGetY,
  // FreeShipping, BundleDiscount, CategoryDiscount, CustomFormula. Real
  // calculation exists only for the first three (see
  // PricingService.js's own doc comment).
  discountType: { type: String, default: null },
  discountValue: { type: Number, default: 0 },
  // "Buy X Get Y" — buy `buyQuantity`, the next `getQuantity` are free;
  // only meaningful when discountType === 'BuyXGetY'.
  buyQuantity: { type: Number, default: null },
  getQuantity: { type: Number, default: null },
  // "Contract Price" — an explicit fixed unit price override, only
  // meaningful when ruleType === 'Contract'. When set, this wins over
  // any resolved price list entry entirely (see resolveBasePrice).
  fixedPrice: { type: Number, default: null },
  // "Tier Pricing... Quantity Breaks" — only meaningful when
  // ruleType === 'Volume'. Sorted by minQuantity descending at
  // resolution time to find the best (highest-quantity) tier the
  // requested quantity qualifies for.
  tiers: { type: [VolumeTierSchema], default: [] },
  // "Stackable discount rules." A non-stackable rule, when it's the
  // single best-discount match across every applicable rule for a line,
  // wins exclusively — every other rule (of any type) is skipped for
  // that line. Defaults true (the common case).
  isStackable: { type: Boolean, default: true },
  // Required per the spec's own "Priority Defined" validation rule —
  // higher number wins when multiple rules of the SAME ruleType and
  // equal specificity both match (ties broken by latest effectiveDate).
  priority: { type: Number, required: true, default: 0 },
  effectiveDate: { type: Date, required: true, index: true },
  endDate: { type: Date, default: null },
  // Config-driven (pricingRuleStatuses) — Draft, Approved, Expired,
  // Archived, Superseded. See utils/financeConfig.js's own doc comment
  // for why "Reviewed"/"Effective"/"Active" aren't separate resting
  // states here.
  status: { type: String, required: true, index: true },
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "pricing_rule", default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PricingRuleSchema.index({ tenantId: 1, ruleName: 1 }, { unique: true });
PricingRuleSchema.index({ tenantId: 1, ruleType: 1, status: 1, effectiveDate: -1 });
PricingRuleSchema.index({ tenantId: 1, status: 1, endDate: 1 });

PricingRuleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PricingRuleModel = mongoose.model("pricing_rule", PricingRuleSchema);

export default PricingRuleModel;
