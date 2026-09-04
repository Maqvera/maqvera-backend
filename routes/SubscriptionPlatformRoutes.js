import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { platformSchemas } from "../middleware/validateRequest.js";
import idempotency from "../middleware/idempotency.js";
import {
  listPlans,
  createPlan,
  updatePlan,
  getSubscription,
  startTrial,
  createSubscription,
  cancelSubscription,
  getBillingAccount,
  setupBillingAccount,
  verifyBillingAccount,
  listInvoices,
  payInvoiceManually,
  chargeInvoiceAutoDebit,
  adminSuspendOwnTenant,
  adminReactivateOwnTenant,
  listSchedulerRuns,
  getSchedulerDashboard,
  listRenewals,
  getRenewalEngineDashboard,
  getRetryEngineDashboard,
  getOwnGraceStatus,
  getGracePeriodDashboard,
  getAccessRevocationDashboard,
  getEnforcementDashboard,
  getNotificationDashboard,
  getBulkProcessingDashboard,
  reprocessBulkProcessingDeadLetter,
  getReactivationDashboard,
  getOperationsDashboard,
  exportOperationsDashboard,
  searchOperations,
  getMerchantTimeline
} from "../controllers/TenantSubscriptionController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Subscription Platform — CORE platform, mounted separately
// from FinanceRoutes.js (app.use("/api/v1/platform", ...) in server.js).
//
// This router itself goes through authenticateAccessToken like every
// other module — including its OWN new enforcement check inside that
// middleware. That's intentional, not circular: a suspended tenant's
// admin genuinely should still be able to reach GET .../subscription and
// .../invoices to see WHY they're suspended and pay their way back in.
// Real-world SaaS platforms keep exactly this "billing area stays
// reachable" carve-out — implemented here simply by NOT double-enforcing
// on top of what authenticateAccessToken.js already does (this router
// adds no additional subscription-status gate of its own), while every
// OTHER module's routes (FinanceRoutes.js, BookingRoutes.js, ...) get the
// same real enforcement automatically through the shared middleware with
// zero changes needed on their end.
router.use(authenticateAccessToken);

// ---- Plan Catalog ----
router.get("/plans", limiter, listPlans);
router.post("/plans", limiter, idempotency(), validate(platformSchemas.createPlan), createPlan);
router.patch("/plans/:planId", limiter, validate(platformSchemas.updatePlan), updatePlan);

// ---- Tenant's own Subscription ----
router.get("/subscription", limiter, getSubscription);
router.post("/subscription/trial", limiter, idempotency(), validate(platformSchemas.startTrial), startTrial);
router.post("/subscription", limiter, idempotency(), validate(platformSchemas.createSubscription), createSubscription);
router.post("/subscription/cancel", limiter, validate(platformSchemas.cancelSubscription), cancelSubscription);
router.post("/subscription/suspend", limiter, validate(platformSchemas.adminSuspend), adminSuspendOwnTenant);
router.post("/subscription/reactivate", limiter, adminReactivateOwnTenant);

// ---- Billing Account ----
router.get("/billing-account", limiter, getBillingAccount);
router.post("/billing-account", limiter, validate(platformSchemas.setupBillingAccount), setupBillingAccount);
router.post("/billing-account/verify", limiter, verifyBillingAccount);

// ---- Invoices ----
router.get("/invoices", limiter, listInvoices);
router.post("/invoices/:invoiceId/pay-manual", limiter, idempotency(), validate(platformSchemas.payInvoiceManually), payInvoiceManually);
router.post("/invoices/:invoiceId/charge", limiter, idempotency(), chargeInvoiceAutoDebit);

// ---- Enterprise Subscription Automation Layer, Automation #1 (Enterprise
// Subscription Scheduler) — Monitoring Dashboard ----
router.get("/subscription-scheduler/runs", limiter, listSchedulerRuns);
router.get("/subscription-scheduler/dashboard", limiter, getSchedulerDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #2 (Enterprise
// Automatic Renewal Engine) — Monitoring Dashboard ----
router.get("/renewal-engine/renewals", limiter, listRenewals);
router.get("/renewal-engine/dashboard", limiter, getRenewalEngineDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #3 (Enterprise
// Payment Retry Strategy) — Monitoring Dashboard ----
router.get("/retry-engine/dashboard", limiter, getRetryEngineDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #4 (Enterprise
// Grace Period Engine) ----
router.get("/grace/status", limiter, getOwnGraceStatus);
router.get("/grace-period-engine/dashboard", limiter, getGracePeriodDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #5 (Enterprise
// Automatic Access Revocation Engine) ----
router.get("/access-revocation/dashboard", limiter, getAccessRevocationDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #6 (Enterprise
// Subscription Enforcement Middleware) ----
router.get("/enforcement/dashboard", limiter, getEnforcementDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #7 (Enterprise
// Notification Timeline) ----
router.get("/notifications/dashboard", limiter, getNotificationDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #8 (Enterprise
// Bulk Processing Engine) ----
router.get("/bulk-processing/dashboard", limiter, getBulkProcessingDashboard);
router.post("/bulk-processing/dead-letters/:dlqId/reprocess", limiter, idempotency(), reprocessBulkProcessingDeadLetter);

// ---- Enterprise Subscription Automation Layer, Automation #9 (Enterprise
// Automatic Reactivation Workflow) ----
router.get("/reactivation/dashboard", limiter, getReactivationDashboard);

// ---- Enterprise Subscription Automation Layer, Automation #10 (Enterprise
// Subscription Operations Dashboard) ----
router.get("/operations/dashboard", limiter, getOperationsDashboard);
router.get("/operations/dashboard/export", limiter, exportOperationsDashboard);
router.get("/operations/search", limiter, searchOperations);
router.get("/operations/merchants/:tenantId/timeline", limiter, getMerchantTimeline);

export default router;
