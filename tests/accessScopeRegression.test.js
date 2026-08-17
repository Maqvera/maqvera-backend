import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the tenant-isolation bugs fixed in
// docs/06-external-integrations/01-tenant-provisioning-fix.md and
// 02-tenant-isolation-audit.md. Runs as part of the normal `node --test`
// suite (no separate CI wiring needed) — a PR that reintroduces any of
// these patterns fails the build here, instead of waiting for the next
// manual audit to catch it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const listJsFiles = (dir) => {
  const full = path.join(repoRoot, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dir, f));
};

const listJsFilesRecursive = (dir) => {
  const full = path.join(repoRoot, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFilesRecursive(relPath);
    return entry.name.endsWith(".js") ? [relPath] : [];
  });
};

const controllerFiles = listJsFiles("controllers");
const middlewareFiles = listJsFiles("middleware");
const scannedFiles = [...controllerFiles, ...middlewareFiles];
// Authorization-gate checks (role-name-allowlist regression, below) also need
// to cover services/ — that's exactly where a second instance of the
// hardcoded-role-gate bug was found (services/ai/AIToolRegistry.js), missed
// by the controllers/middleware-only scan above.
const authGateScannedFiles = [...scannedFiles, ...listJsFilesRecursive("services")];

const readRepoFile = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("no controller/middleware file silently falls back to a fake 'default-tenant'", () => {
  const offenders = scannedFiles.filter((file) => /["'`]default-tenant["'`]/.test(readRepoFile(file)));
  assert.deepEqual(offenders, [], "these files still contain the literal 'default-tenant' fallback string — tenant identity must come only from the verified JWT (req.auth.tenantId), never a made-up default: " + offenders.join(", "));
});

// Broader form of the same bug, found during the controller-by-controller
// rollout: `req.auth?.tenantId || "<anything>"` — a hardcoded fallback tenant
// string, not just the literal "default-tenant". Every real occurrence found
// so far has been fixed to reject instead of default; this is the permanent
// guard against a fresh one being added anywhere (or resurrected here) —
// files that still need this fix are tracked as their own follow-up tasks,
// not silently exempted.
test("no controller/middleware file falls back to any hardcoded literal tenantId", () => {
  const fallbackPattern = /req\.auth\?\.tenantId\s*\|\|\s*["'`][^"'`]+["'`]/;
  const offenders = scannedFiles.filter((file) => fallbackPattern.test(readRepoFile(file)));
  assert.deepEqual(offenders, [], "these files fall back to a hardcoded literal tenantId when req.auth.tenantId is missing, instead of rejecting the request: " + offenders.join(", "));
});

test("no controller/middleware file trusts a client-supplied x-tenant-id/x-branch-id header as a source of tenant identity", () => {
  const headerPattern = /req\.headers\[\s*["'`]x-(tenant|branch)-id["'`]\s*\]/i;
  const offenders = scannedFiles.filter((file) => headerPattern.test(readRepoFile(file)));
  assert.deepEqual(offenders, [], "these files read tenant/branch identity from a client-settable request header — headers are unauthenticated and must never be trusted for this; tenant/branch identity comes only from req.auth (the verified JWT): " + offenders.join(", "));
});

// Every controller here has been migrated to getAccessScope() (utils/accessScope.js)
// for its tenant/branch-owned data queries — see 02-tenant-isolation-audit.md §7/§8's
// controller-by-controller checklist. Add a controller's filename here as part of
// migrating it (never before actually migrating it, or this check stops meaning
// anything). This intentionally does NOT cover every controller in the codebase yet
// — the remaining ones are tracked, not silently assumed fixed (see that doc's §7).
const MIGRATED_TO_ACCESS_SCOPE = [
  "controllers/CustomerController.js",
  "controllers/VisaController.js",
  "controllers/TravelIncidentController.js",
  "controllers/BookingController.js",
  "controllers/UserController.js",
  "controllers/VisaDashboardController.js",
  "controllers/EnterpriseSearchController.js",
  "controllers/TravelDashboardController.js",
  "controllers/TravelAttendanceController.js",
  "controllers/TravelNotesTimelineController.js",
  "controllers/TravelTransportController.js",
  "controllers/TravelItineraryController.js",
  "controllers/TravelFlightController.js",
  "controllers/TravelHotelController.js",
  "controllers/TravelPlanController.js",
  "controllers/FinanceController.js",
  "controllers/JournalController.js",
  "controllers/GeneralLedgerController.js",
  "controllers/AccountsReceivableController.js",
  "controllers/PaymentController.js",
  "controllers/AccountsPayableController.js",
  "controllers/VendorController.js",
  "controllers/ReceiptController.js",
  "controllers/InvoiceController.js",
  "controllers/CreditNoteController.js",
  "controllers/DebitNoteController.js",
  "controllers/RefundController.js",
  "controllers/ChargebackController.js",
  "controllers/BankAccountController.js",
  "controllers/BankReconciliationController.js",
  "controllers/CashManagementController.js",
  "controllers/ExpenseController.js",
  "controllers/VendorPaymentController.js",
  "controllers/CustomerCollectionController.js",
  "controllers/CurrencyController.js",
  "controllers/TaxController.js",
  "controllers/PricingController.js",
  "controllers/ApprovalWorkflowController.js",
  "controllers/SettlementController.js",
  "controllers/FinancialReportController.js",
  "controllers/FinancialDashboardController.js",
  "controllers/FinancialAnalyticsController.js",
  "controllers/AuditComplianceController.js",
  "controllers/OrganisationController.js",
  "controllers/NumberGeneratorController.js",
  "controllers/ResilienceController.js",
  "controllers/EventRegistryController.js",
  "controllers/ApiVersionRegistryController.js",
  "controllers/RateLimitController.js",
];

// Guards the bug found and fixed in VisaDashboardController.js: API/dashboard
// authorization must go through req.auth.permissions (admin-configurable via
// /api/v1/roles — controllers/RoleController.js), never a hardcoded set of
// role-name literals. See
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md.
test("no controller/middleware/service file gates access with a hardcoded role-name allowlist", () => {
  const roleSetPattern = /const\s+\w*ROLES\w*\s*=\s*(new Set\(|\[)/;
  const offenders = authGateScannedFiles.filter((file) => roleSetPattern.test(readRepoFile(file)));
  assert.deepEqual(offenders, [], "these files define a hardcoded role-name allowlist for authorization instead of checking req.auth.permissions/context.permissions: " + offenders.join(", "));
});

test("every controller on the getAccessScope migration list actually imports it", () => {
  const offenders = MIGRATED_TO_ACCESS_SCOPE.filter((relativePath) => {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) return true;
    return !fs.readFileSync(fullPath, "utf8").includes('from "../utils/accessScope.js"');
  });
  assert.deepEqual(offenders, [], "these controllers are on the migrated-to-getAccessScope list but no longer import it — likely reverted to hand-rolled tenant/branch filtering: " + offenders.join(", "));
});
