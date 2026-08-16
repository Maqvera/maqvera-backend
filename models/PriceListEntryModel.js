import mongoose from "mongoose";

// Enterprise Discount & Pricing Engine — Finance Module Part 21. One
// product's price within one PriceListModel — a separate collection
// (not embedded on PriceListModel) so a single entry can be added or
// repriced without rewriting the whole list. `productCode` is a plain,
// opaque SKU string — no Product/Catalog model exists anywhere in this
// codebase, the same "real, but no FK to validate against" treatment
// Part 20 already gave `taxCode`. Tenant-scoped only — no branchId.
const PriceListEntrySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  priceListId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "price_list",
    required: true,
    index: true
  },
  productCode: { type: String, required: true, trim: true, uppercase: true },
  unitPrice: { type: Number, required: true, min: 0 },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PriceListEntrySchema.index({ tenantId: 1, priceListId: 1, productCode: 1 }, { unique: true });

PriceListEntrySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PriceListEntryModel = mongoose.model("price_list_entry", PriceListEntrySchema);

export default PriceListEntryModel;
