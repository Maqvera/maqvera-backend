import mongoose from "mongoose";

// Enterprise Bank Accounts — Finance Module Part 13. "A bank account is not
// just a database record. It is the source of truth for cash movement."
// Tenant-scoped only — no branchId (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md;
// the spec's own "Branch Bank Accounts"/"Branch Match" language is dropped
// per the standing master instructions — see docs/05-api/07-finance-api.md
// Part 13 for the full removal rationale).
//
// The raw account number is never stored in plaintext or returned to any
// client — `accountNumberEncrypted` (AES-256-GCM, utils/fieldEncryption.js)
// is the only place it lives at rest, and `accountNumberHash` (a one-way
// hash of the normalized number) is what the unique-per-tenant index and
// duplicate-detection actually run against, since GCM ciphertext is never
// equal across two encryptions of the same plaintext. `accountNumberLast4`
// is denormalized specifically so the masked value can be rendered without
// decrypting on every list-page read.
const BankAccountSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  bankAccountCode: {
    type: String,
    required: true,
    immutable: true
  },
  bankName: {
    type: String,
    required: true,
    trim: true
  },
  accountName: {
    type: String,
    required: true,
    trim: true
  },
  accountNumberEncrypted: {
    encrypted: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true }
  },
  accountNumberHash: {
    type: String,
    required: true
  },
  accountNumberLast4: {
    type: String,
    required: true
  },
  iban: { type: String, default: null, trim: true },
  swiftCode: { type: String, default: null, trim: true },
  // US ABA routing number — added in Part 17 (Vendor Payments) for real
  // NACHA/ACH payment file generation, which identifies a bank by routing
  // number rather than IBAN/SWIFT.
  routingNumber: { type: String, default: null, trim: true },
  currency: {
    type: String,
    required: true
  },
  // Config-driven (bankAccountTypes) — Operating, Savings, Settlement,
  // Payroll, Escrow, Petty Cash, Treasury, Virtual Account, Custom.
  accountType: {
    type: String,
    required: true,
    index: true
  },
  // Links this bank account to its General Ledger control account (Part 2)
  // — resolved, not fabricated: BankAccountService validates it exists on
  // this tenant's Chart of Accounts before saving. Optional — ledger
  // posting (manual adjustments, future reconciliation) is skipped until
  // configured, same "skip posting until configured" fallback as every
  // other optional account-code link in this module.
  glAccountCode: {
    type: String,
    default: null
  },
  // "Virtual Accounts... Automatically mapped to master account." A
  // virtual account never carries its own real balance — every
  // transaction against it is redirected to `parentAccountId`'s balance by
  // BankAccountService.applyTransaction. See docs/05-api/07-finance-api.md
  // Part 13 for the full reasoning.
  isVirtual: {
    type: Boolean,
    default: false,
    index: true
  },
  parentAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    default: null,
    index: true
  },
  // Config-driven (bankAccountStatuses) — Pending Verification, Verified,
  // Active, Frozen, Suspended, Closed, Archived. See
  // utils/financeConfig.js's own doc comment for why "Created" and
  // "Operational" aren't separate resting states here.
  status: {
    type: String,
    required: true,
    index: true
  },
  // "Balance Types... Calculated automatically." All three are real,
  // mutated only by BankAccountService.applyTransaction/hold/releaseHold —
  // never independently settable through the public update path. `current`
  // is the true ledger balance; `available` is kept in sync as
  // `current - frozen` at every mutation point (same "store the real
  // running number, mutate it precisely at each event" discipline already
  // used for InvoiceModel.outstandingBalance, not a live aggregation).
  // `pendingSettlement` is structurally present for the future Settlement
  // Engine (named only in this Part's own architecture diagrams, not built
  // this pass) — functionally always 0 until that module exists to move it.
  balances: {
    current: { type: Number, default: 0 },
    available: { type: Number, default: 0 },
    frozen: { type: Number, default: 0 },
    pendingSettlement: { type: Number, default: 0 }
  },
  // "Authorized Users" (GET detail response) — who may transact against
  // this account, informational/access-list metadata; RBAC/permission
  // enforcement itself is still `finance.bankaccount.*`, same as every
  // other Finance resource — this is not a parallel authorization system.
  authorizedUsers: [{
    userId: { type: String, required: true },
    role: { type: String, default: null },
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: String, default: null }
  }],
  // "Linked Gateways" — which of this tenant's configured payment gateways
  // (utils/financeConfig.js gateways) settle into this account; informational.
  linkedGateways: [{ type: String }],
  // "Settlement Accounts" (GET detail response) — other bank accounts this
  // one settles into/from; BankAccountService.linkSettlementAccount.
  settlementAccountIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "bank_account" }],
  verifiedBy: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
  activatedBy: { type: String, default: null },
  activatedAt: { type: Date, default: null },
  frozenBy: { type: String, default: null },
  frozenAt: { type: Date, default: null },
  frozenReason: { type: String, default: null },
  suspendedBy: { type: String, default: null },
  suspendedAt: { type: Date, default: null },
  suspendedReason: { type: String, default: null },
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

BankAccountSchema.index({ tenantId: 1, bankAccountCode: 1 }, { unique: true });
BankAccountSchema.index({ tenantId: 1, accountNumberHash: 1 }, { unique: true });
BankAccountSchema.index({ tenantId: 1, status: 1 });
BankAccountSchema.index({ tenantId: 1, accountType: 1 });
BankAccountSchema.index({ tenantId: 1, parentAccountId: 1 });

BankAccountSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    // The raw encrypted blob and the uniqueness hash never leave the
    // server — only a display-safe masked value does.
    delete ret.accountNumberEncrypted;
    delete ret.accountNumberHash;
    ret.accountNumberMasked = ret.accountNumberLast4 ? `****${ret.accountNumberLast4}` : null;
    return ret;
  }
});

const BankAccountModel = mongoose.model("bank_account", BankAccountSchema);

export default BankAccountModel;
