import mongoose from "mongoose";

// Customer Credit — "Overpayments... Credit balance created automatically.
// Customer Credit supports Advance Payments, Overpayments, Manual Credit,
// Credit Notes, Refund Adjustments. Credits reusable." Finance-owned (Part
// 1: "Finance does NOT own Customers") — references Customer by id only.
const CustomerCreditSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  // Decrements as the credit is consumed against future receivables.
  // "Apply existing credit to a receivable" has no endpoint contract yet
  // (deferred — see docs/05-api/07-finance-api.md Part 5) so this only
  // decreases today via manual/administrative means, not a public API.
  remainingAmount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  // Overpayment | AdvancePayment | ManualCredit | CreditNote | RefundAdjustment
  source: {
    type: String,
    required: true
  },
  // The receivable/payment this credit originated from, when applicable.
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

CustomerCreditSchema.index({ tenantId: 1, customerId: 1, status: 1 });

CustomerCreditSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CustomerCreditModel = mongoose.model("customer_credit", CustomerCreditSchema);

export default CustomerCreditModel;
