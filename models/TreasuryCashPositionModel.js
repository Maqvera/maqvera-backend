import mongoose from "mongoose";

// Enterprise Treasury Cash Position — Finance Module Part 18 (TMS).
// Snapshot of enterprise-wide cash visibility, available cash, restricted cash, and pool balances.
// Tenant-scoped only — no branchId per Master Architecture rules.
const AccountBalanceSnapshotSchema = new mongoose.Schema({
  accountId: { type: String, required: true },
  accountName: { type: String, required: true },
  bankName: { type: String, default: null },
  currency: { type: String, required: true },
  accountType: { type: String, required: true },
  currentBalance: { type: Number, required: true, default: 0 },
  availableBalance: { type: Number, required: true, default: 0 },
  restrictedBalance: { type: Number, required: true, default: 0 },
  isVirtual: { type: Boolean, default: false }
}, { _id: false });

const TreasuryCashPositionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  positionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  valuationDate: {
    type: Date,
    required: true,
    index: true
  },
  baseCurrency: {
    type: String,
    required: true,
    default: "USD"
  },
  totalCash: {
    type: Number,
    required: true,
    default: 0
  },
  availableCash: {
    type: Number,
    required: true,
    default: 0
  },
  restrictedCash: {
    type: Number,
    required: true,
    default: 0
  },
  pettyCash: {
    type: Number,
    default: 0
  },
  accountSnapshots: {
    type: [AccountBalanceSnapshotSchema],
    default: []
  },
  calculatedAt: {
    type: Date,
    default: Date.now
  },
  calculatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

TreasuryCashPositionSchema.index({ tenantId: 1, valuationDate: -1 });

TreasuryCashPositionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TreasuryCashPositionModel = mongoose.model("treasury_cash_position", TreasuryCashPositionSchema);

export default TreasuryCashPositionModel;
