import mongoose from "mongoose";

// Package Pricing Engine — PRD §7 "Transport Engine". Tenant-configurable
// vehicle master, replacing the hardcoded Sedan/Hi-Staria/GMC/Hiace/Coaster
// enum found on TravelTransportAssignmentModel/FleetResourceModel (those
// operational models are left untouched — this is the pre-booking rate
// engine's own vehicle catalog, referenced by TransportRateModel).
const TransportVehicleSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  minCapacity: { type: Number, required: true, min: 1 },
  maxCapacity: { type: Number, required: true, min: 1 },
  luggageCapacity: { type: Number, default: null },
  category: { type: String, default: null },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

TransportVehicleSchema.index({ tenantId: 1, name: 1 }, { unique: true });
TransportVehicleSchema.index({ tenantId: 1, active: 1, maxCapacity: 1 });

TransportVehicleSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TransportVehicleModel = mongoose.model("transport_vehicle", TransportVehicleSchema);

export default TransportVehicleModel;
