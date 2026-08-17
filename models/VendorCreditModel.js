import mongoose from "mongoose";

// Vendor Credit — "Vendor Credit: Credit Notes, Vendor Discounts,
// Overpayments, Purchase Returns. Credits reusable." Also the "Advance
// Payments" store: "Advance linked automatically when invoice arrives" —
// AccountsPayableService.createPayable consumes matching Active credits
// (source AdvancePayment or otherwise) automatically when a new payable is
// created for that vendor. Finance-owned; references Vendor by id only.
const VendorCreditSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "vendor",
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  remainingAmount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  // Overpayment | AdvancePayment | VendorDiscount | PurchaseReturn | CreditNote
  source: {
    type: String,
    required: true
  },
  sourceReferenceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  status: {
    type: String,
    enum: ["Active", "Consumed", "Expired"],
    default: "Active",
    index: true
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

VendorCreditSchema.index({ tenantId: 1, vendorId: 1, status: 1 });

VendorCreditSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const VendorCreditModel = mongoose.model("vendor_credit", VendorCreditSchema);

export default VendorCreditModel;
