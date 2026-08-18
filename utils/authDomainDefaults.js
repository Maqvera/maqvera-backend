import PermissionModel from "../models/Permissionmodel.js";
import RoleModel from "../models/Rolemodel.js";

// Single source of truth for the reference permission set, shared by
// scripts/seedAuthDomain.js (dev/on-prem seeding) and Auth.js's SetupTenant
// (self-service tenant onboarding) so the two never drift apart.
export const DEFAULT_PERMISSIONS = [
  { key: "customer.read", description: "Read customer records" },
  { key: "customer.create", description: "Create customer records" },
  { key: "customer.update", description: "Update customer records" },
  { key: "customer.delete", description: "Archive/delete customer records" },
  { key: "customers.read", description: "Read customer records (plural alias)" },
  { key: "customers.create", description: "Create customer records (plural alias)" },
  { key: "customers.update", description: "Update customer records (plural alias)" },
  { key: "customers.delete", description: "Archive/delete customer records (plural alias)" },
  { key: "users.read", description: "Read user/employee records" },
  { key: "users.create", description: "Create user/employee records" },
  { key: "users.update", description: "Update user/employee records" },
  { key: "users.delete", description: "Archive/delete user/employee records" },
  { key: "employee.read", description: "Read employee records (alias)" },
  { key: "employee.create", description: "Create employee records (alias)" },
  { key: "employee.update", description: "Update employee records (alias)" },
  { key: "employee.delete", description: "Archive/delete employee records (alias)" },
  { key: "booking.read", description: "Read booking records" },
  { key: "booking.create", description: "Create booking records" },
  { key: "booking.update", description: "Update booking records" },
  { key: "booking.delete", description: "Delete booking records" },
  { key: "bookings.read", description: "Read booking records (plural alias)" },
  { key: "bookings.create", description: "Create booking records (plural alias)" },
  { key: "bookings.update", description: "Update booking records (plural alias)" },
  { key: "bookings.delete", description: "Delete booking records (plural alias)" },
  // Per-Tenant Payment Gateway Integration — the agency's OWN connected
  // Stripe (later HyperPay/PayPal) account, distinct from `finance.payment.*`
  // below (the Enterprise Payment Engine's own AR/AP payment recording).
  { key: "payments.connect", description: "Connect the tenant's own payment gateway account (e.g. Stripe Connect OAuth)" },
  { key: "payments.disconnect", description: "Disconnect the tenant's own connected payment gateway account" },
  { key: "payments.view", description: "View the tenant's own connected payment gateway accounts (masked account id)" },
  { key: "travel.read", description: "Read travel plan records" },
  { key: "travel.write", description: "Create/update travel plan records" },
  { key: "travel_plans.read", description: "Read travel plan records (alias)" },
  { key: "travel_plans.write", description: "Create/update travel plan records (alias)" },
  { key: "finance.read", description: "Read finance records" },
  { key: "finance.account.read", description: "Read Chart of Accounts records" },
  { key: "finance.account.create", description: "Create Chart of Accounts records" },
  { key: "finance.account.update", description: "Update Chart of Accounts records" },
  { key: "finance.account.delete", description: "Deactivate Chart of Accounts records" },
  { key: "finance.account.manage", description: "Merge accounts, and create/apply Chart of Account templates" },
  { key: "finance.journal.read", description: "Read General Journal entries" },
  { key: "finance.journal.create", description: "Create draft journal entries" },
  { key: "finance.journal.update", description: "Edit draft journals, and cancel unposted journals" },
  { key: "finance.journal.approve", description: "Approve or reject journals pending approval" },
  { key: "finance.journal.post", description: "Post approved journals to the General Ledger" },
  { key: "finance.journal.reverse", description: "Reverse a posted journal via a correcting reversal journal" },
  { key: "finance.journal.correct", description: "Correct a posted journal via a referencing correction journal" },
  { key: "finance.journal.manage", description: "Create/apply journal templates, manage recurring journal schedules, and create journal batches" },
  { key: "finance.ledger.read", description: "Read General Ledger entries, account balances, and trial balance" },
  { key: "finance.receivable.read", description: "Read Accounts Receivable records" },
  { key: "finance.receivable.create", description: "Create Accounts Receivable records" },
  { key: "finance.receivable.update", description: "Allocate payments and update Accounts Receivable records" },
  { key: "finance.receivable.writeoff", description: "Write off an Accounts Receivable balance (management approval gate)" },
  { key: "finance.payment.read", description: "Read payment records" },
  { key: "finance.payment.create", description: "Create/process a payment through the Enterprise Payment Engine (customer, vendor, refund, advance, deposit)" },
  { key: "finance.payment.allocate", description: "Allocate a payment to a receivable, payable, or other target" },
  { key: "finance.payment.void", description: "Void a payment before it has been put to use" },
  { key: "finance.payment.refund", description: "Refund the unallocated portion of a payment" },
  { key: "finance.payable.read", description: "Read Accounts Payable records" },
  { key: "finance.payable.create", description: "Create Accounts Payable records" },
  { key: "finance.payable.approve", description: "Approve a payable for payment" },
  { key: "finance.payable.update", description: "Allocate payments and schedule vendor payments" },
  { key: "finance.payable.writeoff", description: "Write off an Accounts Payable balance (management approval gate)" },
  { key: "finance.vendor.read", description: "Read vendor records" },
  { key: "finance.vendor.create", description: "Create vendor records" },
  { key: "finance.receipt.read", description: "Read receipt records" },
  { key: "finance.receipt.create", description: "Generate receipts (and retry delivery)" },
  { key: "finance.receipt.reissue", description: "Reissue a receipt as a new linked copy" },
  { key: "finance.receipt.cancel", description: "Cancel a receipt (administrative correction)" },
  { key: "finance.invoice.read", description: "Read invoice records" },
  { key: "finance.invoice.create", description: "Create draft invoices" },
  { key: "finance.invoice.update", description: "Edit draft invoices, and close paid invoices" },
  { key: "finance.invoice.approve", description: "Approve an invoice before it is issued" },
  { key: "finance.invoice.issue", description: "Issue an approved invoice (generates the Accounts Receivable record)" },
  { key: "finance.invoice.cancel", description: "Cancel a draft/approved invoice, or void an issued one with no payments yet" },
  { key: "finance.creditnote.read", description: "Read credit note records" },
  { key: "finance.creditnote.create", description: "Create draft credit notes against an issued invoice" },
  { key: "finance.creditnote.approve", description: "Approve a credit note before it is issued" },
  { key: "finance.creditnote.issue", description: "Issue an approved credit note, and allocate/close it against Accounts Receivable" },
  { key: "finance.creditnote.cancel", description: "Cancel a draft/approved credit note, or void an issued one before it is allocated" },
  { key: "finance.debitnote.read", description: "Read debit note records" },
  { key: "finance.debitnote.create", description: "Create draft debit notes against an issued invoice or approved payable" },
  { key: "finance.debitnote.approve", description: "Approve a debit note before it is issued" },
  { key: "finance.debitnote.issue", description: "Issue an approved debit note, and allocate/close it against Accounts Receivable/Payable" },
  { key: "finance.debitnote.cancel", description: "Cancel a draft/approved debit note, or void an issued one before it is allocated" },
  { key: "finance.refund.read", description: "Read refund records" },
  { key: "finance.refund.create", description: "Request a refund against a payment or an allocated credit note" },
  { key: "finance.refund.approve", description: "Move a refund to review, approve, or reject it" },
  { key: "finance.refund.process", description: "Process an approved refund (executes the actual money movement)" },
  { key: "finance.refund.cancel", description: "Cancel a refund before it is processed" },
  { key: "finance.chargeback.read", description: "Read chargeback records" },
  { key: "finance.chargeback.create", description: "File a chargeback against a payment" },
  { key: "finance.chargeback.manage", description: "Submit chargeback evidence and record its final decision (Won/Lost)" },
  { key: "finance.bankaccount.read", description: "Read bank account records and their transaction history" },
  { key: "finance.bankaccount.create", description: "Create bank accounts and virtual accounts" },
  { key: "finance.bankaccount.approve", description: "Verify and activate a bank account" },
  { key: "finance.bankaccount.manage", description: "Update, freeze, suspend, close, archive a bank account, adjust its balance, hold/release funds, and link settlement accounts" },
  { key: "finance.reconciliation.read", description: "Read bank reconciliation sessions, statement transactions, exceptions, and reports" },
  { key: "finance.reconciliation.create", description: "Import a bank statement to start a new reconciliation session" },
  { key: "finance.reconciliation.match", description: "Run auto-matching, manually match/unmatch transactions, resolve exceptions, and generate/accept AI match suggestions" },
  { key: "finance.reconciliation.approve", description: "Approve, complete, or reject a reconciliation session" },
  { key: "finance.reconciliation.manage", description: "Create bank adjustments, reopen, or archive a reconciliation session" },
  { key: "finance.cash.read", description: "Read cash locations, transfers, counts, petty cash advances, and forecasts" },
  { key: "finance.cash.create", description: "Create cash locations and transfers, record cash counts, and issue petty cash advances" },
  { key: "finance.cash.approve", description: "Approve/reject cash transfers and resolve cash count variances" },
  { key: "finance.cash.manage", description: "Update/close/archive a cash location, settle petty cash advances, and replenish petty cash" },
  { key: "finance.expense.read", description: "Read expense claims and expense budgets" },
  { key: "finance.expense.create", description: "Create, edit, submit, upload receipts to, and cancel expense claims" },
  { key: "finance.expense.approve", description: "Approve/reject/return expense claims and verify receipts" },
  { key: "finance.expense.manage", description: "Reimburse and close expense claims, and manage expense budgets" },
  { key: "finance.vendorpayment.read", description: "Read vendor payment proposals, payment batches, and vendor bank accounts" },
  { key: "finance.vendorpayment.create", description: "Create vendor payment proposals, cancel them, and issue vendor advances" },
  { key: "finance.vendorpayment.approve", description: "Approve or reject a vendor payment proposal" },
  { key: "finance.vendorpayment.manage", description: "Hold/release, schedule, execute vendor payments, generate payment files, manage payment batches, and manage vendor bank accounts" },
  { key: "finance.customercollection.read", description: "Read customer collection requests, reminders, and collection analytics" },
  { key: "finance.customercollection.create", description: "Create customer collection requests and customer deposits" },
  { key: "finance.customercollection.approve", description: "Write off a customer collection" },
  { key: "finance.customercollection.manage", description: "Collect payment, dispute, cancel, close, create/reschedule/cancel/settle installment plans, generate payment links, and send reminders for customer collections" },
  { key: "finance.wallet.read", description: "Read wallet records and transaction history" },
  { key: "finance.wallet.create", description: "Create a customer wallet" },
  { key: "finance.wallet.manage", description: "Top up, spend, refund, transfer, withdraw, suspend, reactivate, and close wallets" },
  { key: "finance.subscription.read", description: "Read subscription and membership records" },
  { key: "finance.subscription.create", description: "Create a subscription or membership" },
  { key: "finance.subscription.manage", description: "Run billing cycles, record usage, change plans, pause/resume/cancel/terminate subscriptions and memberships" },
  { key: "finance.collectioncampaign.read", description: "Read collection campaigns and target previews" },
  { key: "finance.collectioncampaign.manage", description: "Create, run, and cancel collection campaigns" },
  { key: "finance.webhook.read", description: "Read webhook subscriptions and delivery history" },
  { key: "finance.webhook.manage", description: "Create/rotate/suspend/reactivate/disable webhook subscriptions and replay deliveries" },
  { key: "finance.currency.read", description: "Read currencies, exchange rates, revaluation history, and currency exposure reports" },
  { key: "finance.currency.manage", description: "Create/activate/suspend/archive currencies, record and import exchange rates, and run currency revaluation" },
  { key: "finance.tax.read", description: "Read tax rules, calculate tax, read exemptions, and read tax reports" },
  { key: "finance.tax.approve", description: "Approve a tax rule" },
  { key: "finance.tax.manage", description: "Create/archive tax rules, manage tax exemptions, and generate tax reports" },
  { key: "finance.pricing.read", description: "Read pricing rules, price lists, coupons, and calculate prices" },
  { key: "finance.pricing.approve", description: "Approve a pricing rule" },
  { key: "finance.pricing.manage", description: "Create/archive pricing rules, manage price lists and price list entries, and create/revoke coupons" },
  { key: "finance.approvalworkflow.read", description: "Read approval workflow definitions, approval requests, and delegations" },
  { key: "finance.approvalworkflow.approve", description: "Approve an approval workflow definition" },
  { key: "finance.approvalworkflow.manage", description: "Create/archive workflow definitions, start/cancel approval requests, and manage delegations" },
  { key: "finance.settlement.read", description: "Read settlements, settlement batches, and gateway settlement reports" },
  { key: "finance.settlement.create", description: "Create settlement requests" },
  { key: "finance.settlement.manage", description: "Cancel/complete settlements, record adjustments, reconcile settlements, and manage settlement batches" },
  { key: "finance.report.read", description: "Read financial reports, drill-down entries, and report schedules" },
  { key: "finance.report.create", description: "Generate financial reports" },
  { key: "finance.report.manage", description: "Export, archive, and cancel financial reports, and manage report schedules" },
  { key: "finance.dashboard.read", description: "Read financial dashboards, KPIs, trends, and dashboard alerts/preferences" },
  { key: "finance.dashboard.management", description: "View management-only financial dashboards (executive, CFO, treasury, tax) and acknowledge alerts" },
  { key: "finance.analytics.read", description: "Read financial analytics results" },
  { key: "finance.analytics.run", description: "Run financial analytics models (trend, forecast, ratio, variance, scenario, anomaly, executive insight)" },
  { key: "finance.analytics.manage", description: "Cancel and archive financial analytics results" },
  { key: "finance.planning.read", description: "Umbrella read access across budgets, forecasts, variance analyses, scenarios, and the executive planning dashboard" },
  { key: "finance.planning.manage", description: "Umbrella manage access across budgets, forecasts, variance analyses, and scenarios (grants every finance.budget.*/finance.forecast.*/finance.variance.*/finance.scenario.* write action)" },
  { key: "finance.budget.create", description: "Create draft enterprise budgets" },
  { key: "finance.budget.read", description: "Read enterprise budgets and their revision history" },
  { key: "finance.budget.update", description: "Edit a draft/rejected budget, and create a new versioned budget revision" },
  { key: "finance.budget.submit", description: "Submit a draft budget for approval" },
  { key: "finance.budget.approve", description: "Approve, reject, or request revision on a submitted budget" },
  { key: "finance.budget.publish", description: "Publish an approved budget (locks it against further direct edits)" },
  { key: "finance.forecast.create", description: "Generate a financial forecast (revenue, expense, cash flow, rolling, etc.)" },
  { key: "finance.forecast.read", description: "Read financial forecasts" },
  { key: "finance.variance.calculate", description: "Calculate a budget/forecast vs. actual variance analysis" },
  { key: "finance.variance.read", description: "Read variance analyses" },
  { key: "finance.scenario.create", description: "Create a what-if scenario model" },
  { key: "finance.scenario.read", description: "Read scenario models and their evaluated outcomes" },
  { key: "finance.scenario.evaluate", description: "Run a scenario evaluation against its baseline budget/forecast" },
  { key: "finance.treasury.read", description: "Read cash positions, liquidity forecasts, bank sync, investments, debt facilities, FX exposure, and treasury risks" },
  { key: "finance.treasury.manage", description: "Calculate cash positions, generate liquidity forecasts, sync bank balances, manage investments, record debt, calculate FX exposure, and evaluate risks" },
  { key: "finance.governance.read", description: "Read financial governance evaluations, policies, SoD rules, fraud detection checks, audit evidence packages, and governance dashboards" },
  { key: "finance.governance.manage", description: "Evaluate governance policies, manage governance policy definitions, define SoD rules, manage fraud detection checks, and generate audit evidence packages" },
  { key: "finance.platform.read", description: "Read the Finance Platform architecture blueprint and cross-sub-platform health/telemetry status" },
  { key: "finance.platform.orchestrate", description: "Run the end-to-end Finance Platform request pipeline (governance evaluation, treasury impact snapshot, audit signal) for a transaction" },
  { key: "audit.event.create", description: "Submit audit events" },
  { key: "audit.event.read", description: "Read audit events, investigation views, chain integrity checks, and segregation-of-duties/role-conflict checks" },
  { key: "audit.event.manage", description: "Set legal hold on audit events and export evidence" },
  { key: "audit.compliance.manage", description: "Create compliance policies and change their status" },
  // Enterprise Search — Finance Module Part 28. Real, pre-existing gap
  // fix: controllers/EnterpriseSearchController.js's own RebuildSearchIndex
  // handler has always checked `permissions.includes("search.rebuild")`,
  // but this key was never added to the seeded catalog PermissionModel
  // validates role-permission assignment against (controllers/RoleController.js)
  // — meaning no tenant admin could ever grant it to a custom role, only
  // the hardcoded "admin" literal could ever call it. GlobalSearch/
  // GetSearchSuggestions/SaveSearchQuery itself deliberately has no
  // separate permission gate beyond tenant scope — the real access
  // control already happens per-result via each indexed entity's own
  // `permissionsRequired` (see models/SearchIndexModel.js).
  { key: "search.rebuild", description: "Trigger a full Enterprise Search index rebuild for the tenant" },
  { key: "visa.read", description: "Read visa records" },
  { key: "visa.dashboard.management", description: "View management-only visa dashboards (executive, finance, compliance, AI insights)" },
  { key: "reporting.read", description: "Read reporting data" },
  { key: "roles.read", description: "View the company's role catalog and permission assignments" },
  { key: "roles.manage", description: "Create, edit, and delete roles and their permission assignments" },
  { key: "admin", description: "Full administrative override across all modules" },
  // Enterprise Subscription Platform. `platform.subscription.*`/
  // `platform.billing.*` are this tenant's own admin managing their own
  // subscription/billing account — same tenant-scoped RBAC as every
  // other module. `platform.plan.manage` (Plan catalog CRUD) and the
  // cross-tenant suspend/reactivate override endpoints deliberately reuse
  // the existing tenant-scoped "admin" permission rather than a separate
  // platform-operator identity — no such actor (distinct from any
  // tenant's own admin) exists anywhere in this codebase's auth model,
  // and inventing one wasn't part of what was asked; a real, separate
  // "Platform Operator" authentication surface is legitimate future
  // infrastructure, not guessed at here.
  { key: "platform.subscription.read", description: "Read the tenant's own subscription, plan, and billing history" },
  { key: "platform.subscription.manage", description: "Change plan, cancel, or manage the tenant's own subscription" },
  { key: "platform.billing.read", description: "Read the tenant's own billing account and subscription invoices" },
  { key: "platform.billing.manage", description: "Create/update the tenant's own billing account and record/attempt subscription payments" },
  { key: "platform.plan.read", description: "Read the platform's sellable plan catalog" },
  // Enterprise Merchant & Billing Platform (Improvement 3). Merchant
  // create/verify/suspend/reactivate/close and cross-tenant billing
  // consolidation reuse the existing "admin" permission — same
  // no-separate-platform-operator-identity reasoning already recorded in
  // Improvement 1/File 0.
  { key: "platform.merchant.read", description: "Read merchant accounts, wallets, and consolidated billing history" },
  { key: "platform.merchant.manage", description: "Create/verify merchants, manage payment methods, wallets, and refunds" },
  // Enterprise Organisation Structure Platform (Improvement 4). Tenant-scoped
  // like every other module permission — the Organisation hierarchy below
  // Tenant (Organisation -> Legal Entity -> Business Unit -> Company ->
  // Branch -> Department -> Team) is business-owned data, not a second
  // access-control dimension (see utils/accessScope.js and
  // utils/organisationConfig.js's own doc comment on why Branch here is
  // descriptive-only).
  { key: "organisation.read", description: "Read organisation records" },
  { key: "organisation.manage", description: "Create and update organisation records" },
  { key: "legalentity.read", description: "Read legal entity records" },
  { key: "legalentity.manage", description: "Create, update, and activate legal entity records" },
  { key: "businessunit.read", description: "Read business unit records" },
  { key: "businessunit.manage", description: "Create and update business unit records" },
  { key: "company.read", description: "Read company records" },
  { key: "company.manage", description: "Create and update company records" },
  { key: "branch.read", description: "Read branch records" },
  { key: "branch.manage", description: "Create, update, and close branch records" },
  { key: "department.read", description: "Read department records" },
  { key: "department.manage", description: "Create and update department records" },
  { key: "team.read", description: "Read team records" },
  { key: "team.manage", description: "Create and update team records" },
  // Enterprise Identity & Global Resource ID Platform (Improvement 5).
  // numbering.generate is deliberately separate from numbering.manage —
  // any authorized user creating an Invoice/Payment/etc. should be able to
  // trigger number generation without also holding scheme-admin rights.
  { key: "numbering.read", description: "Read numbering schemes and generated-number history" },
  { key: "numbering.manage", description: "Create/update numbering schemes and reset sequence counters" },
  { key: "numbering.generate", description: "Generate, register, and roll back document numbers" },
  // Enterprise Resilience & Reliability Standard (Improvement 6).
  { key: "resilience.read", description: "Read Dead Letter Queue records and Circuit Breaker status" },
  { key: "resilience.manage", description: "Mark Dead Letter Queue records as a permanent failure" },
  // Enterprise Event Versioning Standard (Improvement 7).
  { key: "eventregistry.read", description: "Read the central Event Registry" },
  { key: "eventregistry.manage", description: "Register events and manage their deprecation/retirement lifecycle" },
  // Enterprise API Version Strategy Standard (Improvement 8).
  { key: "apiversion.read", description: "Read the central API Version Registry" },
  { key: "apiversion.manage", description: "Register API versions and manage their deprecation/sunset/retirement lifecycle" },
  // Enterprise API Rate Limiting & Throttling Standard (Improvement 13).
  { key: "ratelimit.read", description: "Read rate limit rules, violations, and top-consumer monitoring data" },
  { key: "ratelimit.manage", description: "Create/update rate limit rules" },
  // Booking-module PRD Part C — Agency/Tenant onboarding profile & document
  // branding (Issue 13/14).
  { key: "tenantprofile.read", description: "Read the tenant's company profile (branding, VAT/registration, default bank account, document settings)" },
  { key: "tenantprofile.manage", description: "Create/update the tenant's company profile, including logo upload" },
];

export const ADMINISTRATOR_ROLE_NAME = "Administrator";

export const ensurePermissionsSeeded = async () => {
  await PermissionModel.bulkWrite(
    DEFAULT_PERMISSIONS.map((permission) => ({
      updateOne: {
        filter: { key: permission.key },
        update: { $set: { ...permission, status: "active" } },
        upsert: true,
      },
    }))
  );
};

// RoleModel.name is unique per tenant, not globally — every tenant gets its
// own independently-editable "Administrator" role document (seeded with the
// same default permission set as a starting point, not a shared reference
// every tenant is locked into). Idempotent: safe to call on every tenant
// setup, not just the first, and safe to re-run for an existing tenant.
export const ensureAdministratorRole = async (tenantId) => {
  if (!tenantId) throw new Error("tenantId is required to provision the Administrator role.");
  await ensurePermissionsSeeded();
  const administratorPermissions = DEFAULT_PERMISSIONS.map((permission) => permission.key);
  return RoleModel.findOneAndUpdate(
    { tenantId, name: ADMINISTRATOR_ROLE_NAME },
    { tenantId, name: ADMINISTRATOR_ROLE_NAME, permissions: administratorPermissions, description: "Full administrative access to every module.", isSystemRole: true, status: "active" },
    { upsert: true, new: true }
  );
};

/**
 * Generic counterpart to `ensureAdministratorRole` above, for an
 * ARBITRARY role name (e.g. `controllers/UserController.js`'s own
 * create-user/invite flows, which accept a free-text `role` field) —
 * ensures a `RoleModel` document exists for this tenant + name, creating
 * a minimal one if not. Deliberately NEVER grants the full Administrator
 * permission set for an arbitrary/unrecognized name (that would be a real
 * privilege-escalation bug: any caller supplying an arbitrary role string
 * would otherwise get full admin rights) — routes to `ensureAdministratorRole`
 * only when the name genuinely IS "Administrator" (case-insensitive),
 * otherwise creates a real, safe, empty-permission starting point a
 * tenant admin must deliberately grant permissions to via
 * `RoleController.js`. `$setOnInsert` (not a full replace, unlike
 * `ensureAdministratorRole`'s own re-sync-to-defaults behavior) — a
 * second caller inviting another user under the same already-customized
 * role name must never silently wipe that role back to zero permissions.
 */
export const ensureTenantRole = async (tenantId, roleName) => {
  if (!tenantId) throw new Error("tenantId is required to provision a role.");
  const trimmedName = (roleName || "").trim();
  if (!trimmedName) throw new Error("roleName is required to provision a role.");

  if (trimmedName.toLowerCase() === ADMINISTRATOR_ROLE_NAME.toLowerCase()) {
    return ensureAdministratorRole(tenantId);
  }

  return RoleModel.findOneAndUpdate(
    { tenantId, name: trimmedName },
    { $setOnInsert: { tenantId, name: trimmedName, permissions: [], description: `Auto-provisioned role: ${trimmedName}.`, isSystemRole: false, status: "active" } },
    { upsert: true, new: true }
  );
};
