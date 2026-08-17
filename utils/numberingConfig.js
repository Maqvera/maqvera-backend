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

// Enterprise Identity & Global Resource ID Platform (Improvement 5) — the
// real, centrally-configurable Number Generator: NumberingSchemeModel
// (the format) + ResourceSequenceModel (the atomic counter, same proven
// findOneAndUpdate($inc) pattern as models/FinanceSequenceModel.js) +
// GeneratedNumberModel (the registry — the honest answer to "Never Expose
// Internal Database Keys": what a public documentNumber/globalResourceId
// actually maps back to internally).
//
// Deliberately a NEW, CORE platform (models/*, not touching
// models/FinanceSequenceModel.js or any existing *Service.js
// `_generateXNumber` method) — same "CORE platform, not Finance" pattern
// already used for Improvements 1/3/4 (TenantBillingAccountModel/
// MerchantAccountModel/OrganisationModel). Rewiring every existing
// Finance service's own hardcoded numbering onto this platform is real,
// deliberate follow-up work (see docs/05-api/11-identity-platform-api.md
// "Cross-Module Adoption"), not attempted in this pass — this platform is
// immediately usable standalone by any new or existing caller that opts
// in via `POST /api/v1/numbering/generate`.
export const getNumberingConfig = () => {
  return {
    schemeStatuses: parseStringList(process.env.NUMBERING_SCHEME_STATUSES_JSON, ["Active", "Inactive"]),
    generatedNumberStatuses: parseStringList(process.env.NUMBERING_GENERATED_STATUSES_JSON, ["Reserved", "Registered", "RolledBack"]),

    defaultSequenceLength: parseInt(process.env.NUMBERING_DEFAULT_SEQUENCE_LENGTH || "6", 10),
    defaultSeparator: process.env.NUMBERING_DEFAULT_SEPARATOR || "-",

    // A suggested/default catalog only — resourceType itself is a free
    // string on NumberingSchemeModel, never a closed enum, because the
    // spec's own "Configurable Formats" requirement (a tenant can scheme
    // ANY resource type, including ones this codebase doesn't know about
    // yet) would be broken by validating against a fixed list.
    resourceTypeCatalog: parseStringList(process.env.NUMBERING_RESOURCE_TYPE_CATALOG_JSON, [
      "Invoice", "Payment", "Receipt", "Expense", "Vendor", "Customer", "Journal",
      "CreditNote", "DebitNote", "Refund", "PurchaseOrder", "SalesOrder", "Budget", "Forecast", "Asset"
    ]),

    // "Support Fiscal-Year Based Numbering" — real, not just a January-Jan
    // calendar year default. 1 = calendar year (matches every existing
    // Finance `_generateXNumber` method's own hardcoded
    // `new Date().getUTCFullYear()`, so a scheme with defaults behaves
    // identically to today's Finance numbering); any other value (e.g. 7
    // for a July-start fiscal year) rolls the fiscal year over a month
    // early, the real, standard fiscal-year convention.
    defaultFiscalYearStartMonth: parseInt(process.env.NUMBERING_DEFAULT_FISCAL_YEAR_START_MONTH || "1", 10),

    defaultPageSize: parseInt(process.env.NUMBERING_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.NUMBERING_MAX_PAGE_SIZE || "100", 10)
  };
};

/** Real fiscal-year computation — month is 1-12. startMonth=1 collapses to the plain calendar year every existing Finance numbering method already uses. */
export const computeFiscalYear = (date, fiscalYearStartMonth = 1) => {
  const calendarYear = date.getUTCFullYear();
  const calendarMonth = date.getUTCMonth() + 1;
  if (fiscalYearStartMonth <= 1) return calendarYear;
  return calendarMonth >= fiscalYearStartMonth ? calendarYear + 1 : calendarYear;
};

export default getNumberingConfig;
