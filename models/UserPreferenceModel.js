import mongoose from "mongoose";

const UserPreferenceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    unique: true,
    index: true,
  },
  language: {
    type: String,
    default: "en",
  },
  timezone: {
    type: String,
    default: "UTC",
  },
  theme: {
    type: String,
    enum: ["light", "dark", "system"],
    default: "light",
  },
  notifications: {
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    push: { type: Boolean, default: true },
  },
  dateFormat: {
    type: String,
    default: "YYYY-MM-DD",
  },
  timeFormat: {
    type: String,
    enum: ["12h", "24h"],
    default: "24h",
  },
  pageSize: {
    type: Number,
    default: 25,
    min: 5,
    max: 100,
  },
  dashboardLayout: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
}, { timestamps: true });

const UserPreferenceModel = mongoose.model("user_preference", UserPreferenceSchema);
export default UserPreferenceModel;
