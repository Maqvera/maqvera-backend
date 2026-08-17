import mongoose from "mongoose";

// Petty Cash Advances — Finance Module Part 15. "Advance Issuance...
// Expense Claims... Replenishment... Closing." An advance is money handed
// out of a Petty Cash location to a specific employee for a purpose, kept
// open until they account for how it was spent (settlement). The actual
// "Expense Claims" workflow (categories, receipts/OCR, approval routing)
// is explicitly Part 16's own scope (see this doc's own Part 16 preview) —
// this model tracks only the real CASH side: money out, and money
// accounted for/returned, not a full expense-claim entity.
const PettyCashAdvanceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  advanceNumber: {
    type: String,
    required: true,
    immutable: true
  },
  cashLocationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "cash_location",
    required: true,
    index: true
  },
  issuedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    index: true
  },
  issuedToName: { type: String, default: null },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true },
  purpose: { type: String, required: true },
  // Decrements as settlements are recorded against it.
  outstandingAmount: { type: Number, required: true },
  status: { type: String, enum: ["Issued", "Partially Settled", "Settled"], required: true, index: true },
  settlements: [{
    amount: { type: Number, required: true },
    description: { type: String, default: null },
    // If any portion of the advance was never spent, the remainder is
    // physically returned to the cash location — this settlement line's
    // own real CashTransactionModel credit.
    returnedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "cash_transaction", default: null },
    settledBy: { type: String, default: null },
    settledAt: { type: Date, default: Date.now }
  }],
  issueTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "cash_transaction", default: null },
  issuedBy: { type: String, default: null },
  issuedAt: { type: Date, default: Date.now },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null }
}, { timestamps: true });

PettyCashAdvanceSchema.index({ tenantId: 1, advanceNumber: 1 }, { unique: true });
PettyCashAdvanceSchema.index({ tenantId: 1, cashLocationId: 1, status: 1 });
PettyCashAdvanceSchema.index({ tenantId: 1, issuedTo: 1, status: 1 });

PettyCashAdvanceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PettyCashAdvanceModel = mongoose.model("petty_cash_advance", PettyCashAdvanceSchema);

export default PettyCashAdvanceModel;
