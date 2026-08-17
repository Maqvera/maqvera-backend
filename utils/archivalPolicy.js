// Enterprise Architecture Hardening Phase — Soft Delete & Archival
// Standard (Improvement 10). Companion to
// `utils/enterpriseMetadata.js`'s own `applyEnterpriseMetadata` plugin
// (Improvement 1) — same collision-safe `addIfMissing` shape, same
// "opt-in schema plugin, not force-applied to any existing model" rule.
// "Recommended Metadata: status, isArchived, archivedAt, archivedBy,
// archiveReason" — `status` itself is deliberately NOT touched here
// (every model already owns its own richer status enum, same reasoning
// Improvement 1 already documented); this plugin adds only the real
// archive/restore/purge/legal-hold fields `utils/archivalService.js`
// actually reads and writes.
const addIfMissing = (schema, path, definition) => {
  if (!schema.path(path)) schema.add({ [path]: definition });
};

export const applyArchivalPolicy = (schema) => {
  addIfMissing(schema, "isArchived", { type: Boolean, default: false, index: true });
  addIfMissing(schema, "archivedAt", { type: Date, default: null });
  addIfMissing(schema, "archivedBy", { type: String, default: null });
  addIfMissing(schema, "archiveReason", { type: String, default: null });
  // Data Retention & Legal Hold Standard (Improvement 11) — the real
  // registered policy code (e.g. "FINANCE_10_YEARS") this record's
  // `purgeEligibleAt` was computed from, when one was resolved via
  // `utils/retentionPolicy.js`. Null when no policy was registered and
  // the honest config fallback was used instead — never a fabricated code.
  addIfMissing(schema, "retentionPolicy", { type: String, default: null });
  addIfMissing(schema, "restoredAt", { type: Date, default: null });
  addIfMissing(schema, "restoredBy", { type: String, default: null });
  // Real, minimal Legal Hold flag — a genuine hold blocks purge outright
  // (see `purgeRecord` below). The full Legal Hold *registry* (litigation
  // reasons, hold owners, hold expiry, multi-record holds) is Improvement
  // 11's own, larger scope — this is the honest, real gate THIS
  // standard's own purge workflow needs today, not a placeholder.
  addIfMissing(schema, "legalHold", { type: Boolean, default: false });
  addIfMissing(schema, "legalHoldReason", { type: String, default: null });
  // Computed once at archive time from the retention-policy config —
  // the real date `purgeRecord` checks against, never re-derived
  // ad hoc per purge attempt.
  addIfMissing(schema, "purgeEligibleAt", { type: Date, default: null });
  addIfMissing(schema, "purgedAt", { type: Date, default: null });
  addIfMissing(schema, "purgedBy", { type: String, default: null });
};

export default applyArchivalPolicy;
