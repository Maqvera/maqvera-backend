import mongoose from "mongoose";

const TrustedDeviceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    index: true,
  },
  deviceId: {
    type: String,
    required: true,
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
  ipAddress: {
    type: String,
    default: null,
  },
  trustedAt: {
    type: Date,
    default: Date.now,
  },
  lastUsedAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    default: null,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

TrustedDeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
TrustedDeviceSchema.index({ userId: 1, isActive: 1 });

const TrustedDeviceModel = mongoose.model("trusted_device", TrustedDeviceSchema);
export default TrustedDeviceModel;
