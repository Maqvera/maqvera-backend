import mongoose from "mongoose";

// Package Pricing Engine — PRD §8 "Flight rate database". Pre-booking cost
// reference, distinct from FlightCatalogModel/FlightBookingModel (which
// carry zero cost fields and only record a price once a booking is
// actually made — see the trace's §2.6).
const FlightRateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  route: { type: String, required: true, trim: true, index: true },
  airline: { type: String, default: null },
  cabin: { type: String, default: "Economy" },
  currency: { type: String, required: true, uppercase: true },
  costPerPerson: { type: Number, required: true, min: 0 },
  direction: { type: String, required: true },
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },
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

FlightRateSchema.index({ tenantId: 1, route: 1, validFrom: 1, validTo: 1 });
FlightRateSchema.index({ tenantId: 1, status: 1 });

FlightRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const FlightRateModel = mongoose.model("flight_rate", FlightRateSchema);

export default FlightRateModel;
