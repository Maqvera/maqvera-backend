import mongoose from "mongoose";

// Package Pricing Engine — PRD §74 "Supplier Management": "Every rate
// should have Supplier, Contract, Source, Date received, Valid from/until,
// Currency, Notes, Uploaded document... so the agency can know 'Where did
// this rate come from?'" Every rate model's own free-text `supplier`
// string stays (display convenience); `supplierId` on each rate model
// links to this real, queryable master so a rate is traceable back to an
// actual supplier record, not just a label.
const SupplierSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true },
  contactName: { type: String, default: null },
  phone: { type: String, default: null },
  email: { type: String, default: null },
  currency: { type: String, default: null, uppercase: true },
  notes: { type: String, default: null },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

SupplierSchema.index({ tenantId: 1, name: 1 });
SupplierSchema.index({ tenantId: 1, category: 1, active: 1 });

SupplierSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const SupplierModel = mongoose.model("package_supplier", SupplierSchema);

export default SupplierModel;
