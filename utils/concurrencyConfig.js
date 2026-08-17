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

// Enterprise Architecture Hardening Phase — Optimistic Locking Standard
// (Improvement 2). "Financial posting resources remain immutable after
// posting" / "Posted financial records remain immutable and are excluded
// from optimistic locking." These resource types are never updated once
// posted (this codebase already enforces that per-module, e.g.
// JournalModel/LedgerEntryModel never expose an update path once
// `status: "Posted"`) — this catalog exists so
// `utils/optimisticLocking.js`'s own `assertMutableResource` has a real,
// centrally-configurable list to check a resourceType against, instead of
// each future adopter re-deciding this per module.
export const getConcurrencyConfig = () => {
  return {
    immutableResourceTypes: parseStringList(process.env.CONCURRENCY_IMMUTABLE_RESOURCE_TYPES_JSON, [
      "Journal", "AuditLog", "LedgerEntry", "PostedPayment", "PostedInvoice", "PostedReceipt", "PostedExpense", "DomainEvent", "GeneratedNumber"
    ])
  };
};

export default getConcurrencyConfig;
