import mongoose from "mongoose";

/**
 * Reporting Platform Part 13 fix (Step 2) — tamper-evident audit trail
 * specifically for report/dashboard view+download, additional to (not a
 * replacement for) the plain `models/AuditLogmodel.js` entries every
 * controller already writes. Copies `models/AuditEventModel.js`'s proven
 * hash-chain/immutability structure verbatim (sequence/previousHash/hash
 * via SHA-256, `MUTABLE_FIELDS` append-only guard on save/update/delete —
 * see that file's own doc comment for the full rationale) but with
 * reporting-scoped fields instead of Finance's `category`/`entityType`:
 * `module` (dashboardModules), `resourceType`/`resourceKey` (a report's
 * `reportType`/ReportCatalogModel `reportKey`, or a dashboard's
 * `dashboardType`), `action` (VIEW/EXPORT/DOWNLOAD/DRILL_THROUGH).
 * services/ReportAuditService.js computes the hash chain over THIS
 * schema's own fields — not AuditEventModel's canonical-JSON shape, which
 * includes fields this schema doesn't have.
 */
const REPORT_AUDIT_ACTIONS = ["VIEW", "EXPORT", "DOWNLOAD", "DRILL_THROUGH"];

const ReportAuditEventSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  sequence: { type: Number, required: true },
  previousHash: { type: String, default: null },
  hash: { type: String, required: true, index: true },
  correlationId: { type: String, default: null, index: true },
  module: { type: String, required: true, index: true },
  resourceType: { type: String, required: true, enum: ["Report", "Dashboard"], index: true },
  resourceKey: { type: String, required: true, index: true },
  action: { type: String, required: true, enum: REPORT_AUDIT_ACTIONS, index: true },
  userId: { type: String, default: null, index: true },
  userEmail: { type: String, default: null },
  ipAddress: { type: String, default: null },
  format: { type: String, default: null },
  timestamp: { type: Date, required: true, default: Date.now },
  status: { type: String, required: true, default: "Active", index: true },
  legalHold: { type: Boolean, default: false, index: true },
  expiresAt: { type: Date, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

ReportAuditEventSchema.index({ tenantId: 1, sequence: 1 }, { unique: true });
ReportAuditEventSchema.index({ tenantId: 1, resourceType: 1, resourceKey: 1, timestamp: -1 });
ReportAuditEventSchema.index({ tenantId: 1, status: 1, legalHold: 1, expiresAt: 1 });

const IMMUTABLE_ERROR = "Report audit events are append-only and tamper-evident — only legalHold/status/updatedBy may change after creation, and events cannot be deleted.";
const MUTABLE_FIELDS = new Set(["legalHold", "status", "updatedBy"]);

// Pure, no-DB guard logic — exported and unit-tested directly
// (tests/reportAuditService.test.js) rather than only exercised indirectly
// through mongoose's own pre-hook dispatch, which requires a live
// connection to reach via a real Query.exec().
export const findDisallowedModifiedPaths = (modifiedPaths) => modifiedPaths.filter((path) => !MUTABLE_FIELDS.has(path));

export const findDisallowedUpdateFields = (update) => {
  const setFields = Object.keys(update?.$set || update || {}).filter((key) => !key.startsWith("$"));
  return setFields.filter((key) => !MUTABLE_FIELDS.has(key));
};

ReportAuditEventSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const disallowed = findDisallowedModifiedPaths(this.modifiedPaths());
  if (disallowed.length > 0) return next(new Error(IMMUTABLE_ERROR));
  next();
});

const guardUpdateQuery = function (next) {
  const disallowed = findDisallowedUpdateFields(this.getUpdate());
  if (disallowed.length > 0) return next(new Error(IMMUTABLE_ERROR));
  next();
};
ReportAuditEventSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], { document: false, query: true }, guardUpdateQuery);
ReportAuditEventSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], { document: false, query: true }, function (next) {
  next(new Error(IMMUTABLE_ERROR));
});

ReportAuditEventSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReportAuditEventModel = mongoose.model("report_audit_event", ReportAuditEventSchema);

export default ReportAuditEventModel;
export { REPORT_AUDIT_ACTIONS, IMMUTABLE_ERROR, MUTABLE_FIELDS };
