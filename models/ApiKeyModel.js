import mongoose from "mongoose";

// PRD "CRM Feature Map by Phase" Phase 4 module 33 (Developer Portal) —
// self-serve API key issuance on top of the already-built webhook/OpenAPI
// platform. Only the SHA-256 hash of the raw key is ever stored (same
// utils/authTokens.js hashToken() convention used for refresh tokens) — the
// raw key is returned exactly once, at creation time, and is unrecoverable
// after that. `keyPrefix` (the raw key's own first ~12 characters) is stored
// unhashed purely so a listing UI can show "mvk_a1b2c3..." to help a user
// tell their keys apart without ever re-exposing the full secret.
const ApiKeySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  keyPrefix: {
    type: String,
    required: true
  },
  hashedKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // A snapshot subset of the creating user's own permissions at issuance
  // time — a key can never be minted with MORE access than its creator
  // held (enforced in the controller, not here), and later role changes to
  // the creator don't retroactively change what an already-issued key can do.
  permissions: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ["Active", "Revoked"],
    default: "Active",
    index: true
  },
  expiresAt: {
    type: Date,
    default: null
  },
  lastUsedAt: {
    type: Date,
    default: null
  },
  createdBy: { type: String, default: null },
  revokedBy: { type: String, default: null },
  revokedAt: { type: Date, default: null }
}, { timestamps: true });

ApiKeySchema.index({ tenantId: 1, status: 1 });

ApiKeySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    delete ret.hashedKey;
    return ret;
  }
});

const ApiKeyModel = mongoose.model("api_key", ApiKeySchema);

export default ApiKeyModel;
