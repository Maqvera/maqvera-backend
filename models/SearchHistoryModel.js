import mongoose from "mongoose";

const SearchHistorySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  query: { type: String, default: "", trim: true, maxlength: 500 },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  resultCount: { type: Number, default: 0 },
  accessedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

SearchHistorySchema.index({ tenantId: 1, userId: 1, accessedAt: -1 });

export default mongoose.model("search_history", SearchHistorySchema);
