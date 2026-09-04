import mongoose from "mongoose";

// Supplier Self-Service Portal (PRD "CRM Feature Map by Phase" Phase 3
// module 24). Scoped to `vendor` (models/VendorModel.js — the Finance
// domain's own AP record, the one `VendorPaymentModel` actually references),
// NOT `package_supplier` (models/SupplierModel.js — the Package Pricing
// Engine's separate rate-sourcing record). These are two real, independent
// models in this codebase that happen to describe a similar real-world
// entity; this portal is deliberately built against the one that actually
// has a payment history to show a supplier ("GET /supplier-portal/payments"
// needs real VendorPaymentModel rows, which only exist against `vendorId`).
//
// Same hashed-secret + revocation discipline as ApiKeyModel.js (only the
// SHA-256 hash is ever stored, via utils/authTokens.js's hashToken()) —
// deliberately NOT CustomerPortalTokenModel.js's raw-stored, single-view-
// link pattern, since a supplier reuses this credential repeatedly
// (including for a real write endpoint, invoice submission), unlike a
// customer's one-off receipt-viewing link.
const VendorPortalTokenSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "vendor",
    required: true,
    index: true
  },
  name: { type: String, default: null },
  keyPrefix: { type: String, required: true },
  hashedKey: { type: String, required: true, unique: true, index: true },
  status: {
    type: String,
    enum: ["Active", "Revoked"],
    default: "Active",
    index: true
  },
  expiresAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  revokedBy: { type: String, default: null },
  revokedAt: { type: Date, default: null }
}, { timestamps: true });

VendorPortalTokenSchema.index({ tenantId: 1, vendorId: 1, status: 1 });

VendorPortalTokenSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    delete ret.hashedKey;
    return ret;
  }
});

const VendorPortalTokenModel = mongoose.model("vendor_portal_token", VendorPortalTokenSchema);

export default VendorPortalTokenModel;
