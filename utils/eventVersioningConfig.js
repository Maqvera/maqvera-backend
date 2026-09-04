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

// Enterprise Architecture Hardening Phase — Event Versioning Standard
// (Improvement 7). "Event Categories: Domain Events (business facts) /
// Integration Events (external communication) / System Events (internal
// platform events)" and the real deprecation lifecycle status machine
// ("Publish v1 -> Publish v2 -> Run Both -> Migration Window -> Deprecate
// v1 -> Retire v1").
export const getEventVersioningConfig = () => {
  return {
    eventCategories: parseStringList(process.env.EVENT_VERSIONING_CATEGORIES_JSON, ["Domain", "Integration", "System"]),
    eventStatuses: parseStringList(process.env.EVENT_VERSIONING_STATUSES_JSON, ["Active", "Deprecated", "Retired"]),
    defaultPageSize: parseInt(process.env.EVENT_VERSIONING_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.EVENT_VERSIONING_MAX_PAGE_SIZE || "100", 10)
  };
};

export default getEventVersioningConfig;
