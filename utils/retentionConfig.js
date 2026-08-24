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

// Enterprise Architecture Hardening Phase — Data Retention & Legal Hold
// Standard (Improvement 11). "Standard Retention Policies" — the spec's
// own table, made real, admin-configurable defaults (a tenant can
// register its own override via `utils/retentionPolicy.js`, these are
// only what applies when nothing has been registered yet).
const DEFAULT_RETENTION_YEARS_BY_RESOURCE_TYPE = {
  Journal: 10, Invoice: 10, Payment: 10, Receipt: 10, TaxRecord: 10,
  AuditRecord: 10, CreditNote: 10, DebitNote: 10, LedgerEntry: 10,
  Forecast: 5, AnalyticsSnapshot: 5,
  IntegrationLog: 2, Notification: 1,
  // Part 15 fix — Communication Platform records. CommunicationAudit
  // mirrors AuditRecord's own 10-year compliance window; CommunicationMessage
  // is the transactional record itself (an Email/SMS/WhatsApp/Push send),
  // shorter-lived like IntegrationLog/Notification.
  CommunicationMessage: 2, CommunicationAudit: 10
};

export const getRetentionConfig = () => {
  return {
    policyStatuses: parseStringList(process.env.RETENTION_POLICY_STATUSES_JSON, ["Active", "Inactive"]),
    legalHoldStatuses: parseStringList(process.env.RETENTION_LEGAL_HOLD_STATUSES_JSON, ["Active", "Removed"]),
    purgeRequestStatuses: parseStringList(process.env.RETENTION_PURGE_REQUEST_STATUSES_JSON, ["Pending", "Approved", "Rejected", "Completed"]),
    defaultRetentionYearsByResourceType: parseJson(process.env.RETENTION_DEFAULT_YEARS_BY_TYPE_JSON, DEFAULT_RETENTION_YEARS_BY_RESOURCE_TYPE),
    // The honest fallback when a resourceType has neither a registered
    // policy nor an entry in the table above — same 7-year default
    // Improvement 10's own archivalConfig already used, kept in sync
    // rather than picking a second, different number.
    fallbackRetentionYears: parseInt(process.env.RETENTION_FALLBACK_YEARS || "7", 10),
    defaultPageSize: parseInt(process.env.RETENTION_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.RETENTION_MAX_PAGE_SIZE || "100", 10)
  };
};

export default getRetentionConfig;
