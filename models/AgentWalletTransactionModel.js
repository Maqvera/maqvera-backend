import mongoose from "mongoose";

// B2B Agent Portal — PRD "CRM Feature Map by Phase" Phase 2 module 14.
// Append-only ledger, mirroring models/WalletTransactionModel.js exactly —
// nothing here is ever updated or deleted after creation, `balanceAfter`
// is a real snapshot taken at write time.
const AgentWalletTransactionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "agent_wallet",
    required: true,
    index: true
  },
  // "CommissionEarned" (a qualifying booking), "Adjustment" (manual
  // correction), "Payout" (reserved for the future cash-out flow —
  // AgentWalletModel's own doc comment — never written by this pass).
  type: {
    type: String,
    required: true,
    index: true
  },
  direction: {
    type: String,
    enum: ["Credit", "Debit"],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "booking_header", default: null },
  commissionRuleId: { type: mongoose.Schema.Types.ObjectId, ref: "commission_rule", default: null },
  description: { type: String, default: null },
  performedBy: { type: String, default: null }
}, { timestamps: true });

AgentWalletTransactionSchema.index({ tenantId: 1, walletId: 1, createdAt: -1 });

AgentWalletTransactionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const AgentWalletTransactionModel = mongoose.model("agent_wallet_transaction", AgentWalletTransactionSchema);

export default AgentWalletTransactionModel;
