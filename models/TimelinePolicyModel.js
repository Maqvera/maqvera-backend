import mongoose from "mongoose";

const TimelinePolicySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true, index: true },
  noteTypes: [{ type: String }],
  visibilityLevels: [{ type: String }],
  maxNoteLength: { type: Number, required: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model("timeline_policy", TimelinePolicySchema);
