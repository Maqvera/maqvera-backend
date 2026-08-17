import mongoose from "mongoose";

// Enterprise Merchant & Billing Platform — CORE platform, same family as
// TenantSubscriptionModel/TenantBillingAccountModel (Improvement 1), not
// Finance. "Tenant != Customer != Merchant != Legal Entity != Billing
// Account." The real, new top-of-hierarchy commercial identity: "ABC
// Holdings" the organisation, not any one of its operating companies.
//
// "Merchant cannot login. Users login. Merchant is commercial identity
// only." — this model has no password/session/role fields whatsoever,
// deliberately, unlike TenantModel/UserModel.
//
// `tenantIds` is the real answer to "ABC Holdings owns 4 companies...
// should they purchase 4 subscriptions? NO" — the set of tenants (each
// still a fully isolated, independent Company-as-Tenant per the standing
// architecture) commercially grouped under this one merchant. Data
// isolation between member tenants is completely untouched — this is a
// purely COMMERCIAL grouping, never a data-access one. Not tenant-scoped
// itself (a merchant sits ABOVE any single tenant) — no branchId either
// way, this codebase has no Branch concept.
const MerchantAccountSchema = new mongoose.Schema({
  merchantCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  organisationName: { type: String, required: true },
  legalName: { type: String, required: true },
  taxNumber: { type: String, default: null },
  registrationNumber: { type: String, default: null },
  country: { type: String, default: null },
  primaryContact: {
    name: { type: String, default: null },
    email: { type: String, default: null },
    phone: { type: String, default: null }
  },
  billingEmail: { type: String, required: true },
  // Config-driven (merchantStatuses) — Prospect, Registered, Verified,
  // Subscribed, Active, Suspended, Closed.
  status: { type: String, required: true, index: true },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: String, default: null },
  suspendedAt: { type: Date, default: null },
  suspensionReason: { type: String, default: null },
  closedAt: { type: Date, default: null },
  // The real "one merchant, multiple companies" grouping — every tenantId
  // here keeps its own full, independent TenantSubscriptionModel row
  // (per-tenant enforcement stays real and granular); this array is what
  // ties them together commercially. See TenantBillingAccountModel's own
  // doc comment for how a shared billing account references this same set.
  tenantIds: { type: [String], default: [] },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, {
  timestamps: true,
  optimisticConcurrency: true
});

MerchantAccountSchema.index({ tenantIds: 1 });

MerchantAccountSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const MerchantAccountModel = mongoose.model("merchant_account", MerchantAccountSchema);

export default MerchantAccountModel;
