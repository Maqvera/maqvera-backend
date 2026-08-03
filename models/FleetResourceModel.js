import mongoose from "mongoose";

const FleetResourceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  vehicleNumber: {
    type: String,
    required: true,
    index: true
  },
  plateNumber: {
    type: String,
    required: true
  },
  vehicleType: {
    type: String,
    enum: ["Bus", "Coaster", "GMC", "SUV", "Sedan", "Van", "VIP Bus"],
    default: "Bus",
    index: true
  },
  capacity: {
    type: Number,
    required: true,
    default: 50
  },
  driverName: {
    type: String,
    required: true
  },
  driverPhone: {
    type: String,
    required: true
  },
  driverLicenseNumber: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ["available", "assigned", "maintenance", "out_of_service"],
    default: "available",
    index: true
  },
  currentLocation: {
    checkpointName: { type: String, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    updatedAt: { type: Date, default: Date.now }
  }
}, { timestamps: true });

FleetResourceSchema.index({ tenantId: 1, vehicleType: 1, status: 1 });

const FleetResourceModel = mongoose.model("fleet_resource", FleetResourceSchema);

export default FleetResourceModel;
