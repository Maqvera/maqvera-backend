import mongoose from "mongoose";

// Enterprise Discount & Pricing Engine — Finance Module Part 21. "Coupon
// Support... Single Use, Multi Use, Expiry Date, Usage Limits, Customer
// Specific, Product Specific." A real, redemption-tracked entity —
// structurally different from PricingRuleModel (a coupon has a CODE the
// customer enters and real consumption to track, not just an
// effective-dated discount), so it's kept separate rather than folded in
// as another `ruleType`. Redemptions are embedded (mirrors this
// codebase's own established pattern — VendorPaymentModel.approvals[],
// AccountsReceivableModel.allocations[] — rather than a parallel
// collection for a resource this size). Tenant-scoped only — no
// branchId.
const CouponRedemptionSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", default: null },
  transactionRef: { type: String, default: null },
  amount: { type: Number, required: true },
  redeemedAt: { type: Date, default: Date.now }
}, { _id: false });

const CouponSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  // Config-driven (discountTypes) — real calculation only for
  // Percentage/FixedAmount (see PricingService.js's own doc comment).
  discountType: { type: String, required: true },
  discountValue: { type: Number, required: true, min: 0 },
  // Config-driven (couponUsageTypes) — SingleUse, MultiUse.
  usageType: { type: String, required: true },
  // null = unlimited (still bounded by usageType === 'SingleUse'
  // meaning exactly 1 regardless of this field).
  usageLimit: { type: Number, default: null },
  usedCount: { type: Number, default: 0 },
  // null = no per-customer cap beyond the overall usageLimit/usageType.
  perCustomerLimit: { type: Number, default: null },
  // Empty = applies to every product/customer.
  applicableProductCodes: { type: [String], default: [] },
  applicableCustomerIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  validFrom: { type: Date, required: true },
  validUntil: { type: Date, default: null },
  // Active | Expired | Exhausted | Revoked.
  status: { type: String, required: true, default: "Active" },
  revokedReason: { type: String, default: null },
  redemptions: { type: [CouponRedemptionSchema], default: [] },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CouponSchema.index({ tenantId: 1, code: 1 }, { unique: true });
CouponSchema.index({ tenantId: 1, status: 1 });

CouponSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CouponModel = mongoose.model("coupon", CouponSchema);

export default CouponModel;
