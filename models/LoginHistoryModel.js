import mongoose from "mongoose";

const LoginHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
    index: true,
  },
  email: {
    type: String,
    default: null,
    index: true,
  },
  tenantId: {
    type: String,
    default: null,
    index: true,
  },
  branchId: {
    type: String,
    default: null,
    index: true,
  },
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "session",
    default: null,
  },
  action: {
    type: String,
    enum: ["login", "mfa_login", "login_failed"],
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ["success", "failed"],
    required: true,
    index: true,
  },
  failureReason: {
    type: String,
    default: null,
  },
  ipAddress: {
    type: String,
    default: null,
  },
  country: {
    type: String,
    default: null,
  },
  city: {
    type: String,
    default: null,
  },
  deviceId: {
    type: String,
    default: null,
  },
  deviceName: {
    type: String,
    default: null,
  },
  browser: {
    type: String,
    default: null,
  },
  os: {
    type: String,
    default: null,
  },
  userAgent: {
    type: String,
    default: null,
  },
  riskScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  isSuspicious: {
    type: Boolean,
    default: false,
  },
  requestId: {
    type: String,
    default: null,
  },
}, { timestamps: true });

LoginHistorySchema.index({ userId: 1, createdAt: -1 });
LoginHistorySchema.index({ email: 1, createdAt: -1 });
LoginHistorySchema.index({ tenantId: 1, status: 1, createdAt: -1 });
LoginHistorySchema.index({ ipAddress: 1, createdAt: -1 });

const LoginHistoryModel = mongoose.model("login_history", LoginHistorySchema);
export default LoginHistoryModel;
