import mongoose from "mongoose";

const PasswordHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    index: true,
  },
  passwordHash: {
    type: String,
    required: true,
  },
  changedAt: {
    type: Date,
    default: Date.now,
  },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
  reason: {
    type: String,
    enum: ["change", "reset", "admin_reset"],
    required: true,
  },
  requestId: {
    type: String,
    default: null,
  },
}, { timestamps: false });

PasswordHistorySchema.index({ userId: 1, changedAt: -1 });

const PasswordHistoryModel = mongoose.model("password_history", PasswordHistorySchema);
export default PasswordHistoryModel;
