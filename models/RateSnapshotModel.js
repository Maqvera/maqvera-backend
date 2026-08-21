import mongoose from "mongoose";

// Package Pricing Engine — PRD §7 (Golden Rule) "Every finalized package
// stores a rate snapshot... so the price is reproducible later even if
// source rates change." Persists the exact hotel/transport/flight/visa/
// exchange rate rows (id AND value) used by one calculate/finalize run —
// a later edit to the source rate can never silently change a package that
// already has a snapshot.
const RateSnapshotSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "package",
    required: true,
    index: true
  },
  snapshotType: { type: String, required: true, enum: ["Calculate", "Finalize"] },
  hotelRates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  transportRates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  flightRates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  visaRates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  exchangeRates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  roomWisePriceMatrix: { type: [mongoose.Schema.Types.Mixed], default: [] },
  capturedAt: { type: Date, default: Date.now },
  performedBy: { type: String, default: null }
}, { timestamps: true });

RateSnapshotSchema.index({ tenantId: 1, packageId: 1, createdAt: -1 });

RateSnapshotSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RateSnapshotModel = mongoose.model("rate_snapshot", RateSnapshotSchema);

export default RateSnapshotModel;
