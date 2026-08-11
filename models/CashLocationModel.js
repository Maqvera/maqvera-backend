import mongoose from "mongoose";

// Enterprise Cash Management — Finance Module Part 15. "Cash != Bank" —
// physical money (cash drawers, petty cash, safes, vaults, POS tills), a
// deliberately separate model family from Part 13's BankAccountModel even
// though that model's own `accountType` enum already listed "Petty Cash" —
// the user's own spec settles this: Cash and Bank "are managed separately
// because they have different business rules, risks, controls, and audit
// requirements." Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md;
// the spec's own "Branch Vaults"/"Validate Branch" language is dropped per
// the standing master instructions — see docs/05-api/07-finance-api.md
// Part 15).
const CashLocationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  cashLocationCode: {
    type: String,
    required: true,
    immutable: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  // Config-driven (cashLocationTypes) — Cash Drawer, Petty Cash, Cash
  // Counter, Safe, Vault, POS Till, Custom.
  type: {
    type: String,
    required: true,
    index: true
  },
  currency: {
    type: String,
    required: true
  },
  // Links this location to its General Ledger control account (Part 2) —
  // resolved against the tenant's real Chart of Accounts, same "skip
  // ledger posting until configured" fallback as every other optional
  // account-code link in this module if left unset.
  glAccountCode: { type: String, default: null },
  // Real ref (models/Usermodel.js) — "Responsible Employee." Finance does
  // not own Users/Employees (same boundary discipline already applied to
  // Customer/Vendor) — this is a reference, not ownership.
  responsibleEmployeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null
  },
  responsibleEmployeeName: { type: String, default: null },
  balance: { type: Number, default: 0 },
  // Config-driven (cashLocationStatuses) — Opened, Closed, Archived. See
  // utils/financeConfig.js's own doc comment for why "Location Created"/
  // "Operational"/"Cash Transactions"/"Cash Count"/"Balanced"/"Shortage"/
  // "Overage" aren't resting status values here.
  status: {
    type: String,
    required: true,
    index: true
  },
  // "Dual Control... Dual Authorization... Optional." When true, any
  // CashTransferModel touching this location (either side) requires two
  // DIFFERENT users' approvals before it executes — see
  // CashManagementService.createCashTransfer/approveCashTransfer.
  dualAuthorizationRequired: { type: Boolean, default: false },
  // The float this location should be replenished back up to — meaningful
  // for Petty Cash ("Replenishment"); null for locations with no fixed
  // target (a bank-facing Safe/Vault typically has none).
  targetFloatAmount: { type: Number, default: null },
  openedBy: { type: String, default: null },
  openedAt: { type: Date, default: null },
  closedBy: { type: String, default: null },
  closedAt: { type: Date, default: null },
  closedReason: { type: String, default: null },
  archivedBy: { type: String, default: null },
  archivedAt: { type: Date, default: null },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

CashLocationSchema.index({ tenantId: 1, cashLocationCode: 1 }, { unique: true });
// "Unique Location Name" (Validation Rules) — unique per tenant.
CashLocationSchema.index({ tenantId: 1, name: 1 }, { unique: true });
CashLocationSchema.index({ tenantId: 1, status: 1 });
CashLocationSchema.index({ tenantId: 1, type: 1 });

CashLocationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CashLocationModel = mongoose.model("cash_location", CashLocationSchema);

export default CashLocationModel;
