import mongoose from "mongoose";

// Enterprise Treasury Foreign Exchange (FX) Management — Part 18 (TMS).
// Multi-currency balances, exchange rates, FX exposure, hedging, currency gains/losses.
// Tenant-scoped only — no branchId per Master Architecture rules.
const TreasuryFXExposureSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  exposureId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  currency: {
    type: String,
    required: true,
    index: true
  },
  baseCurrency: {
    type: String,
    required: true,
    default: "USD"
  },
  longPosition: {
    type: Number,
    required: true,
    default: 0
  },
  shortPosition: {
    type: Number,
    required: true,
    default: 0
  },
  netExposure: {
    type: Number,
    required: true,
    default: 0
  },
  hedgedAmount: {
    type: Number,
    default: 0
  },
  unhedgedExposure: {
    type: Number,
    default: 0
  },
  exchangeRate: {
    type: Number,
    required: true,
    default: 1.0
  },
  baseCurrencyValue: {
    type: Number,
    required: true,
    default: 0
  },
  varPct: {
    type: Number,
    default: 0
  },
  varAmount: {
    type: Number,
    default: 0
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  updatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

TreasuryFXExposureSchema.index({ tenantId: 1, currency: 1 }, { unique: true });

TreasuryFXExposureSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TreasuryFXExposureModel = mongoose.model("treasury_fx_exposure", TreasuryFXExposureSchema);

export default TreasuryFXExposureModel;
