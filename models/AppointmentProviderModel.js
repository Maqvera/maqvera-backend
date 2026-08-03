import mongoose from "mongoose";

const AppointmentProviderSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  providerId: { type: String, required: true },
  name: { type: String, required: true },
  providerType: { type: String, enum: ["Embassy", "Consulate", "VAC", "Hospital", "Medical_Center", "Biometric_Center", "Courier_Office", "Government_Office", "Private_Partner"], required: true },
  locations: [{ locationId: String, name: String, dailyCapacity: { type: Number, default: 1 }, slotCapacity: { type: Number, default: 1 }, openingTime: { type: String, default: "09:00" }, closingTime: { type: String, default: "17:00" }, blackoutDates: [String] }],
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

AppointmentProviderSchema.index({ tenantId: 1, providerId: 1 }, { unique: true });
export default mongoose.model("appointment_provider", AppointmentProviderSchema);
