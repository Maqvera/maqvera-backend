import mongoose from "mongoose";

const SavedSearchSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  queryParams: { type: mongoose.Schema.Types.Mixed, required: true },
  visibility: { type: String, enum: ["private", "department"], default: "private", index: true },
  isPinned: { type: Boolean, default: false, index: true },
  lastUsedAt: { type: Date, default: null },
  isSoftDeleted: { type: Boolean, default: false, index: true },
}, { timestamps: true });

SavedSearchSchema.index({ tenantId: 1, userId: 1, isSoftDeleted: 1, updatedAt: -1 });

export default mongoose.model("saved_search", SavedSearchSchema);
