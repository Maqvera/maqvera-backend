import mongoose from "mongoose";

// B2B Agent Portal — PRD "CRM Feature Map by Phase" Phase 2 module 14.
// Mirrors models/WalletModel.js's own structure and balance-caching
// discipline exactly (`balance` is a cached running total, always updated
// in the same operation as the AgentWalletTransactionModel row that
// changes it — that model is the append-only source of truth), just owned
// by an Agent instead of a Customer. Scope boundary, same as
// models/MerchantWalletModel.js's own documented one: this tracks
// commission OWED to an agent — crediting it (on a qualifying booking) is
// real, but there is no payout/cash-out flow here. That's real, buildable
// follow-up work, not attempted in this pass.
const AgentWalletSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  walletNumber: {
    type: String,
    required: true,
    immutable: true
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "agent",
    required: true,
    index: true
  },
  // Denormalized snapshot — same convention as WalletModel's customerName.
  agentName: {
    type: String,
    required: true
  },
  currency: {
    type: String,
    required: true
  },
  balance: {
    type: Number,
    required: true,
    default: 0
  },
  status: {
    type: String,
    enum: ["Active", "Suspended"],
    default: "Active",
    index: true
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

AgentWalletSchema.index({ tenantId: 1, walletNumber: 1 }, { unique: true });
// One real wallet per agent/currency — commission crediting always
// resolves unambiguously.
AgentWalletSchema.index({ tenantId: 1, agentId: 1, currency: 1 }, { unique: true });

AgentWalletSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const AgentWalletModel = mongoose.model("agent_wallet", AgentWalletSchema);

export default AgentWalletModel;
