import mongoose from "mongoose";

// Minimal Vendor record — Accounts Payable (Part 6) needs a real vendor to
// owe money to, but no Vendor/Supplier/Purchasing module exists anywhere in
// this codebase (same situation Part 5 hit with Payments). Deliberately
// small — name/contact/terms — not the eventual Procurement module's
// richer vendor profile (categories, compliance docs, contracts). Finance
// *references* Vendor by id, the same boundary discipline as Customer
// (Part 1: "Finance does NOT own Customers") — Vendor conceptually belongs
// to a future Purchasing domain.
//
// `bankAccounts[]` was added in Part 17 (Vendor Payments) — the "Vendor
// Bank Accounts... Multiple Accounts, Primary Account, Country Rules,
// IBAN, SWIFT/BIC" business need this model's own original comment already
// flagged as future scope ("bank details") is now real: a genuine
// extension of this existing model rather than a parallel one, per the
// standing master instructions' "if it partially exists, extend it"
// discipline.
const VendorBankAccountSchema = new mongoose.Schema({
  accountName: { type: String, required: true },
  bankName: { type: String, required: true },
  country: { type: String, required: true },
  currency: { type: String, required: true },
  iban: { type: String, default: null },
  swiftBic: { type: String, default: null },
  // Fallback account identifier for countries/banks that don't use IBAN.
  accountNumber: { type: String, default: null },
  isPrimary: { type: Boolean, default: false },
  addedBy: { type: String, default: null },
  addedAt: { type: Date, default: Date.now }
}, { _id: true });

const VendorSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  contactEmail: {
    type: String,
    default: null
  },
  contactPhone: {
    type: String,
    default: null
  },
  currency: {
    type: String,
    required: true
  },
  // "Vendor Aging" / "Payment Scheduling" reference point — how many days
  // after the invoice date this vendor's payables are normally due, used
  // only as a default when a payable's own dueDate isn't supplied.
  paymentTermsDays: {
    type: Number,
    default: 30,
    min: 0
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
    index: true
  },
  bankAccounts: [VendorBankAccountSchema],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

VendorSchema.index({ tenantId: 1, name: 1 });

VendorSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const VendorModel = mongoose.model("vendor", VendorSchema);

export default VendorModel;
