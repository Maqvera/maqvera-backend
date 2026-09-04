import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim()).filter(Boolean);
};

// Enterprise Architecture Hardening Phase — Soft Delete & Archival
// Standard (Improvement 10). "Hard Delete Policy — Financial modules
// (Journal Entries, Invoices, Payments, Receipts, Tax Records, Assets,
// Audit Records): NEVER. Non-Financial Modules (Temporary Reports, Draft
// Notifications, Cache, Sessions, Temporary Uploads, Search Cache): MAY
// be allowed" — the spec's own two lists, made real and checkable via
// `utils/archivalService.js`'s own `assertHardDeleteAllowed`.
export const getArchivalConfig = () => {
  return {
    financialResourceTypes: parseStringList(process.env.ARCHIVAL_FINANCIAL_RESOURCE_TYPES_JSON, [
      "Journal", "Invoice", "Payment", "Receipt", "TaxRecord", "Asset", "AuditRecord", "CreditNote", "DebitNote", "LedgerEntry"
    ]),
    hardDeleteAllowedResourceTypes: parseStringList(process.env.ARCHIVAL_HARD_DELETE_ALLOWED_RESOURCE_TYPES_JSON, [
      "TemporaryReport", "DraftNotification", "Cache", "Session", "TemporaryUpload", "SearchCache"
    ]),
    // Real default retention window a purge-eligibility date is computed
    // from at archive time — 7 years is the common real-world minimum for
    // financial records in most jurisdictions; per-call overrideable
    // (`archiveRecord({ retentionYears })`), never hardcoded per module.
    defaultRetentionYears: parseInt(process.env.ARCHIVAL_DEFAULT_RETENTION_YEARS || "7", 10)
  };
};

export default getArchivalConfig;
