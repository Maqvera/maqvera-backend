import mongoose from "mongoose";

// Enterprise Discount & Pricing Engine — Finance Module Part 21. "Price
// Lists... Retail, Wholesale, Distributor, Corporate, Government,
// Export, Custom Lists." A price list resolves the real BASE price for a
// product (before any discount rule ever runs) — either assigned to one
// specific customer directly, targeted at a customer group (matching the
// customer's own already-shipped `category` field — Part 1), or the
// tenant's own default list for a currency. Tenant-scoped only — no
// branchId. Individual product prices live in the separate
// `PriceListEntryModel` (one row per product, not embedded here) so a
// single price can be added/updated without rewriting the whole list.
const PriceListSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true },
  // Config-driven (priceListTypes is not its own list — reuses
  // pricingRuleTypes' sibling concept loosely; listType is free-form
  // config-driven text matching the spec's own named categories).
  listType: { type: String, required: true },
  currency: { type: String, required: true, uppercase: true },
  // Exactly one of these narrows who this list applies to — null/null
  // means "the tenant's general list for this currency" (used when
  // `isDefault` is true and neither is set).
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", default: null, index: true },
  customerGroup: { type: String, default: null },
  isDefault: { type: Boolean, default: false },
  // Draft | Active | Archived.
  status: { type: String, required: true, default: "Draft" },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PriceListSchema.index({ tenantId: 1, currency: 1, isDefault: 1, status: 1 });
PriceListSchema.index({ tenantId: 1, customerId: 1, status: 1 });
PriceListSchema.index({ tenantId: 1, customerGroup: 1, status: 1 });

PriceListSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PriceListModel = mongoose.model("price_list", PriceListSchema);

export default PriceListModel;
