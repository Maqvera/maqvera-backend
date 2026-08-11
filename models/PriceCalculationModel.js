import mongoose from "mongoose";

// Enterprise Discount & Pricing Engine — Finance Module Part 21.
// "Historical invoices can always be recalculated using the pricing
// rules that were effective at the time of sale." Mirrors Part 20's own
// TaxCalculationModel exactly: one immutable row per real
// `POST /api/v1/pricing/calculate` call, the "Calculation Trace" the
// spec's own Response Includes list names, never edited after creation.
// Tenant-scoped only — no branchId.
const PriceCalculationLineSchema = new mongoose.Schema({
  productCode: { type: String, default: null },
  quantity: { type: Number, required: true },
  basePrice: { type: Number, required: true },
  priceListId: { type: mongoose.Schema.Types.ObjectId, ref: "price_list", default: null },
  contractRuleId: { type: mongoose.Schema.Types.ObjectId, ref: "pricing_rule", default: null },
  // One entry per rule that actually contributed a discount to this
  // line, in application order — the real "Applied Rules"/"Calculation
  // Trace" the spec's Response Includes names.
  appliedRules: [{
    ruleId: { type: mongoose.Schema.Types.ObjectId, ref: "pricing_rule", default: null },
    ruleType: { type: String, required: true },
    description: { type: String, default: null },
    discountAmount: { type: Number, required: true }
  }],
  couponCode: { type: String, default: null },
  couponDiscountAmount: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  finalUnitPrice: { type: Number, required: true },
  lineTotal: { type: Number, required: true }
}, { _id: false });

const PriceCalculationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", default: null, index: true },
  currency: { type: String, required: true },
  transactionRef: { type: String, default: null },
  lines: { type: [PriceCalculationLineSchema], default: [] },
  subtotal: { type: Number, required: true },
  discountTotal: { type: Number, required: true },
  taxTotal: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  calculatedAt: { type: Date, default: Date.now },
  performedBy: { type: String, default: null }
}, { timestamps: true });

PriceCalculationSchema.index({ tenantId: 1, calculatedAt: -1 });
PriceCalculationSchema.index({ tenantId: 1, customerId: 1, calculatedAt: -1 });

PriceCalculationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PriceCalculationModel = mongoose.model("price_calculation", PriceCalculationSchema);

export default PriceCalculationModel;
