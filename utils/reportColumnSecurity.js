import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

// Reporting Platform Part 11 (scoped down — see the companion "no
// branch-level row scoping" decision in docs/06-external-integrations/
// 03-final-architecture-no-branches-rbac.md; row-level security by
// branch/company was explicitly rejected for this codebase, but
// column-level masking has no such conflict — it's the same RBAC
// permission model every other endpoint already uses, applied per-field
// instead of per-endpoint). Real, admin-configurable field->permission map
// (env JSON override), not hardcoded per report type — a field name that
// appears in ANY report's flattened rows gets masked consistently.
const DEFAULT_SENSITIVE_FIELD_PERMISSIONS = {
  passportNumber: "visa.passports.read",
  nationalId: "customer.pii.read",
  cnic: "customer.pii.read",
  ssn: "customer.pii.read",
  bankAccountNumber: "finance.bankaccount.read",
  accountNumber: "finance.bankaccount.read",
  taxId: "finance.tax.read"
};

export const getReportColumnSecurityConfig = () => ({
  sensitiveFieldPermissions: parseJson(process.env.REPORT_SENSITIVE_FIELD_PERMISSIONS_JSON, DEFAULT_SENSITIVE_FIELD_PERMISSIONS),
  maskPlaceholder: process.env.REPORT_MASK_PLACEHOLDER || "***"
});

/**
 * Masks any sensitive field present on a row when the caller lacks the
 * field's required permission — enforced here, in the shared export
 * pipeline, never left to a client to hide a column it already received.
 * `permissions === null` (the default across every existing caller of
 * ReportExportService today) means "no permission context supplied" and is
 * intentionally a no-op — this is additive, opt-in masking, not a breaking
 * change to every report export that existed before this file did.
 */
export const maskSensitiveColumns = (rows, permissions = null) => {
  if (!permissions) return rows;
  const config = getReportColumnSecurityConfig();
  const fieldEntries = Object.entries(config.sensitiveFieldPermissions);
  if (fieldEntries.length === 0) return rows;

  const hasAccess = (permission) => permissions.includes("admin") || permissions.includes(permission);

  return rows.map((row) => {
    let masked = null;
    for (const [field, requiredPermission] of fieldEntries) {
      if (Object.prototype.hasOwnProperty.call(row, field) && !hasAccess(requiredPermission)) {
        if (!masked) masked = { ...row };
        masked[field] = config.maskPlaceholder;
      }
    }
    return masked || row;
  });
};

export default maskSensitiveColumns;
