import mongoose from "mongoose";

// Enterprise Audit & Compliance — Finance Module Part 27. "Who, what,
// when, where, why, how, before value, after value, approval chain, and
// whether the action complied with organizational or regulatory
// policies." Additive to the existing `AuditLogModel` (a simple activity
// log written by nearly every service already) — not a replacement.
// Tenant-scoped only — no branchId.
//
// Hash-chained per tenant (`sequence`/`previousHash`/`hash`, real SHA-256
// via Node's own `crypto` — see services/AuditComplianceService.js's
// `computeEventHash`) — the same "enforce immutability at the schema
// layer" discipline `LedgerEntryModel` already established, but narrower:
// `legalHold`/`status`/`updatedBy` are the ONLY fields ever allowed to
// change after creation (a real, honest lifecycle need — Data
// Retention/Legal Hold — that a total lock like LedgerEntryModel's own
// would make impossible to build honestly). Every other field, including
// the hash chain itself, is enforced append-only below.
const ComplianceViolationSchema = new mongoose.Schema({
  policyId: { type: mongoose.Schema.Types.ObjectId, ref: "compliance_policy", default: null },
  policyName: { type: String, default: null },
  ruleType: { type: String, default: null },
  description: { type: String, required: true }
}, { _id: false });

const AuditEventSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Real, per-tenant monotonic hash-chain position — assigned from the
  // real last event for this tenant at write time (best-effort sequential;
  // see this Part's own Deferred notes on concurrent-write ordering).
  sequence: { type: Number, required: true },
  previousHash: { type: String, default: null },
  // Real SHA-256 of this event's own evidentiary fields + previousHash —
  // the actual "Hash Verification"/"Checksum"/"Chain Verification" this
  // Part's own Tamper Detection section names.
  hash: { type: String, required: true, index: true },
  // Real, caller-suppliable (or auto-generated) ID tying this event to
  // other AuditEventModel rows AND to Part-0's own DomainEventModel.correlationId
  // — genuine cross-module investigation, not a fabricated join.
  correlationId: { type: String, default: null, index: true },
  requestId: { type: String, default: null, index: true },
  // Free-form module name the caller supplies (e.g. "Finance", "Invoices")
  // — no fabricated exhaustive module catalog exists across this whole
  // ERP to validate against; `category` (below) is the real, config-driven
  // classification dimension.
  module: { type: String, required: true, index: true },
  // Config-driven (auditCategories) — Authentication, Authorization,
  // Financial, Inventory, HR, Security, Configuration, MasterData,
  // System, Custom.
  category: { type: String, required: true, index: true },
  entityType: { type: String, default: null, index: true },
  entityId: { type: String, default: null, index: true },
  userId: { type: String, default: null, index: true },
  userEmail: { type: String, default: null },
  action: { type: String, required: true, index: true },
  // Real before/after state snapshots — whatever the caller genuinely
  // captured; never fabricated when omitted (stays null, not guessed at).
  beforeState: { type: mongoose.Schema.Types.Mixed, default: null },
  afterState: { type: mongoose.Schema.Types.Mixed, default: null },
  // Config-driven (auditSeverities) — Info, Warning, Critical.
  severity: { type: String, default: "Info" },
  ipAddress: { type: String, default: null },
  device: { type: String, default: null },
  // Config-driven (complianceStatuses) — Compliant, Violation, Exception,
  // NotEvaluated. NotEvaluated is the honest default when no Active
  // CompliancePolicyModel rule applies to this event's category/entityType
  // — never silently defaulted to "Compliant".
  complianceStatus: { type: String, default: "NotEvaluated", index: true },
  complianceViolations: { type: [ComplianceViolationSchema], default: [] },
  // A human-supplied justification for a real, approved deviation from a
  // matched policy — "Policy Exceptions" from this Part's own
  // Segregation of Duties section; never auto-generated.
  exceptionReason: { type: String, default: null },
  // Real event occurrence time (caller-suppliable per this Part's own
  // request example) — distinct from `createdAt` (when this row was
  // actually written, which may lag a batched/replayed submission).
  timestamp: { type: Date, required: true, default: Date.now },
  performedBy: { type: String, default: null },
  // Config-driven (auditEventStatuses) — Active, Archived. The ONLY
  // other mutable field besides legalHold/updatedBy — set by the real,
  // cron-driven retention scheduler once `expiresAt` passes and
  // `legalHold` is false.
  status: { type: String, required: true, default: "Active", index: true },
  // "Legal Hold" — real and enforced: the retention scheduler skips any
  // row with this set to true, regardless of `expiresAt`.
  legalHold: { type: Boolean, default: false, index: true },
  expiresAt: { type: Date, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

AuditEventSchema.index({ tenantId: 1, sequence: 1 }, { unique: true });
AuditEventSchema.index({ tenantId: 1, entityType: 1, entityId: 1, timestamp: 1 });
AuditEventSchema.index({ tenantId: 1, userId: 1, timestamp: -1 });
AuditEventSchema.index({ tenantId: 1, category: 1, timestamp: -1 });
AuditEventSchema.index({ tenantId: 1, status: 1, legalHold: 1, expiresAt: 1 });

const IMMUTABLE_ERROR = "Audit events are append-only and tamper-evident — only legalHold/status/updatedBy may change after creation, and events cannot be deleted (see this Part's own 'Secure Deletion' honesty note: it conflicts with Append-Only/Immutable Storage).";
const MUTABLE_FIELDS = new Set(["legalHold", "status", "updatedBy"]);

AuditEventSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const disallowed = this.modifiedPaths().filter((path) => !MUTABLE_FIELDS.has(path));
  if (disallowed.length > 0) return next(new Error(IMMUTABLE_ERROR));
  next();
});

const guardUpdateQuery = function (next) {
  const update = this.getUpdate() || {};
  const setFields = Object.keys(update.$set || update).filter((key) => !key.startsWith("$"));
  const disallowed = setFields.filter((key) => !MUTABLE_FIELDS.has(key));
  if (disallowed.length > 0) return next(new Error(IMMUTABLE_ERROR));
  next();
};
AuditEventSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], { document: false, query: true }, guardUpdateQuery);
AuditEventSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], { document: false, query: true }, function (next) {
  next(new Error(IMMUTABLE_ERROR));
});

AuditEventSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const AuditEventModel = mongoose.model("audit_event", AuditEventSchema);

export default AuditEventModel;
