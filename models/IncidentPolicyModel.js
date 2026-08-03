import mongoose from "mongoose";

const IncidentPolicySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true, index: true },
  categories: [{ name: String, isActive: { type: Boolean, default: true }, locksVisaCase: { type: Boolean, default: false } }],
  severities: [{ name: String, firstResponseMins: Number, resolutionHours: Number, locksVisaCase: { type: Boolean, default: false }, isActive: { type: Boolean, default: true } }],
  defaultAssignmentTeam: { type: String, required: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model("incident_policy", IncidentPolicySchema);
