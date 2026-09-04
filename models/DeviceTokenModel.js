import mongoose from "mongoose";

/**
 * Enterprise Push Notification Platform — Device Registry (Part 5).
 * One row per real device/browser installation. A token belongs to exactly
 * one row (unique per tenant+token) — re-registering the same token (app
 * reinstall, user re-login, token refresh) updates that row rather than
 * creating a duplicate; re-registering under a different userId correctly
 * reassigns the device (e.g. a shared device logging in as someone else).
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const DeviceTokenSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  platform: {
    type: String,
    enum: ["ios", "android", "web"],
    required: true
  },
  token: {
    type: String,
    required: true
  },
  topics: {
    type: [String],
    default: []
  },
  lastSeenAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

DeviceTokenSchema.index({ tenantId: 1, token: 1 }, { unique: true });
DeviceTokenSchema.index({ tenantId: 1, userId: 1 });
DeviceTokenSchema.index({ tenantId: 1, topics: 1 });

DeviceTokenSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const DeviceTokenModel = mongoose.model("device_token", DeviceTokenSchema);

export default DeviceTokenModel;
