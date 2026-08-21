import mongoose from "mongoose";

// Package Pricing Engine — PRD §7. origin -> destination -> vehicle rate
// lookup for any route (Golden Rule 4 — no hardcoded Umrah-only legs like
// Airport->Makkah). `origin`/`destination` are free text (city/landmark
// names), matched exactly the same way HotelRateModel's rateBasis windows
// are — never a hardcoded route enum.
const TransportRateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  origin: { type: String, required: true, trim: true, index: true },
  destination: { type: String, required: true, trim: true, index: true },
  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "transport_vehicle",
    required: true,
    index: true
  },
  currency: { type: String, required: true, uppercase: true },
  rate: { type: Number, required: true, min: 0 },
  direction: { type: String, required: true },
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },
  supplier: { type: String, default: null },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "package_supplier", default: null },
  contractRef: { type: String, default: null },
  receivedDate: { type: Date, default: null },
  notes: { type: String, default: null },
  documentUrl: { type: String, default: null },
  status: { type: String, required: true, index: true },
  source: { type: String, required: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

TransportRateSchema.index({ tenantId: 1, origin: 1, destination: 1, vehicleId: 1, validFrom: 1, validTo: 1 });
TransportRateSchema.index({ tenantId: 1, status: 1 });

TransportRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TransportRateModel = mongoose.model("transport_rate", TransportRateSchema);

export default TransportRateModel;
