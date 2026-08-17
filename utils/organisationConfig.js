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

// Enterprise Organisation Structure Platform (Improvement 4) — the
// canonical, admin-configurable hierarchy every other module's
// organisationId/legalEntityId/businessUnitId/companyId/branchId/
// departmentId/teamId references resolve against:
//
//   Merchant -> Billing Account -> Tenant -> Organisation -> Legal Entity
//   -> [Business Unit] -> Company -> Branch -> Department -> Team
//
// Tenant remains the ONLY data-isolation boundary in this codebase (see
// utils/accessScope.js and docs/06-external-integrations/
// 03-final-architecture-no-branches-rbac.md) — every entity below is
// scoped by tenantId, but none of them (Branch included) is ever used to
// restrict what a tenant's own users can see. Branch here is purely a
// descriptive/organisational node (a physical office under a Company),
// re-added deliberately as hierarchy metadata, NOT as the branch-level
// access-isolation dimension that was previously removed and is
// permanently banned from getAccessScope()/access-control filtering.
export const getOrganisationConfig = () => {
  return {
    organisationStatuses: parseStringList(process.env.ORG_ORGANISATION_STATUSES_JSON, ["Active", "Inactive", "Suspended", "Closed"]),
    organisationNumberPrefix: process.env.ORG_ORGANISATION_NUMBER_PREFIX || "ORG",

    // "Legal Entity... registered company recognised by government."
    // Pending -> Active is the real, explicit transition the
    // LegalEntityActivated domain event fires on.
    legalEntityStatuses: parseStringList(process.env.ORG_LEGAL_ENTITY_STATUSES_JSON, ["Pending", "Active", "Inactive", "Suspended", "Closed"]),
    legalEntityNumberPrefix: process.env.ORG_LEGAL_ENTITY_NUMBER_PREFIX || "LE",

    businessUnitStatuses: parseStringList(process.env.ORG_BUSINESS_UNIT_STATUSES_JSON, ["Active", "Inactive", "Closed"]),
    businessUnitNumberPrefix: process.env.ORG_BUSINESS_UNIT_NUMBER_PREFIX || "BU",

    companyStatuses: parseStringList(process.env.ORG_COMPANY_STATUSES_JSON, ["Active", "Inactive", "Suspended", "Closed"]),
    companyNumberPrefix: process.env.ORG_COMPANY_NUMBER_PREFIX || "CO",

    // Branch is descriptive-only (see module doc comment above) — its
    // statuses reflect that: a branch is either open (Active/Inactive) or
    // permanently Closed, never itself the reason a request is denied.
    branchStatuses: parseStringList(process.env.ORG_BRANCH_STATUSES_JSON, ["Active", "Inactive", "Closed"]),
    branchNumberPrefix: process.env.ORG_BRANCH_NUMBER_PREFIX || "BR",

    // Department's own `status` enum predates this platform
    // (models/Departmentmodel.js: active/inactive/suspended/deleted,
    // lowercase, hardcoded) and is left exactly as-is — only the new
    // companyId/branchId hierarchy links were added to that model.
    departmentNumberPrefix: process.env.ORG_DEPARTMENT_NUMBER_PREFIX || "DEPT",

    teamStatuses: parseStringList(process.env.ORG_TEAM_STATUSES_JSON, ["Active", "Inactive", "Closed"]),
    teamNumberPrefix: process.env.ORG_TEAM_NUMBER_PREFIX || "TEAM",

    defaultPageSize: parseInt(process.env.ORG_DEFAULT_PAGE_SIZE || "20", 10),
    maxPageSize: parseInt(process.env.ORG_MAX_PAGE_SIZE || "100", 10)
  };
};

export default getOrganisationConfig;
