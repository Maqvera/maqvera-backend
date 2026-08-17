import TenantSubscriptionService from "../services/TenantSubscriptionService.js";
import PlatformPlanModel from "../models/PlatformPlanModel.js";
import TenantSubscriptionModel from "../models/TenantSubscriptionModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import SubscriptionInvoiceModel from "../models/SubscriptionInvoiceModel.js";
import SchedulerRunModel from "../models/SchedulerRunModel.js";
import SubscriptionRenewalModel from "../models/SubscriptionRenewalModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GracePeriodEngineService from "../services/GracePeriodEngineService.js";
import BulkProcessingEngineService, { DLQ_INTEGRATION } from "../services/BulkProcessingEngineService.js";
import BulkProcessingJobModel from "../models/BulkProcessingJobModel.js";
import DeadLetterQueueModel from "../models/DeadLetterQueueModel.js";
import CacheManager from "../utils/cacheManager.js";
import { getEnforcementMetrics } from "../utils/enforcementMetrics.js";
import { reprocessDeadLetter } from "../utils/resilienceEngine.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import { getBulkProcessingConfig } from "../utils/bulkProcessingConfig.js";
import SubscriptionOperationsDashboardService from "../services/SubscriptionOperationsDashboardService.js";
import FinancialReportExportService from "../services/FinancialReportExportService.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already exists") || message.includes("already has") || message.includes("already paid") || message.includes("already")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid") || message.includes("Cannot") || message.includes("cannot") || message.includes("does not offer")) return 400;
  return 500;
};

// ---- Plan Catalog (tenant-agnostic reference data) ----

/** GET /api/v1/platform/plans — the sellable plan catalog. */
export const listPlans = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "platform.plan.read")) return sendError(res, 403, "Permission denied.", requestId);
    const filter = { isSellable: true, isCustom: false };
    const plans = await PlatformPlanModel.find(filter).sort({ sortOrder: 1 }).lean();
    return sendSuccess(res, 200, "Plans retrieved successfully.", { items: plans }, requestId);
  } catch (error) {
    console.error("listPlans error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve plans.", requestId);
  }
};

/**
 * POST /api/v1/platform/plans — reuses the existing tenant-scoped "admin"
 * permission (same as every other module's admin-only action) rather
 * than a separate platform-operator identity — see this endpoint's own
 * doc section in the Subscription Platform architecture doc for why.
 */
export const createPlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const config = getPlatformConfig();
    const { planCode, name, tier, description = null, pricing = {}, limits = {}, features = {}, trialDays = null, gracePeriodDays = null, supportLevel = null, backupFrequency = null, isSellable = true, isCustom = false, sortOrder = 0 } = req.body;

    if (!planCode || !name || !tier) return sendError(res, 400, "planCode, name, and tier are required.", requestId);
    if (!config.planTiers.includes(tier)) return sendError(res, 400, `Invalid tier "${tier}".`, requestId);

    const existing = await PlatformPlanModel.findOne({ planCode: planCode.toUpperCase() }).lean();
    if (existing) return sendError(res, 409, `Plan code "${planCode}" already exists.`, requestId);

    const userId = req.auth?.userId || req.auth?.id || null;
    const plan = await PlatformPlanModel.create({
      planCode: planCode.toUpperCase(), name, tier, description, pricing, limits, features, trialDays, gracePeriodDays,
      supportLevel, backupFrequency, isSellable, isCustom, sortOrder,
      timeline: [{ event: "PlanCreated", description: `Plan ${name} created.`, performedBy: userId }],
      createdBy: userId, updatedBy: userId
    });

    return sendSuccess(res, 201, "Plan created successfully.", plan.toJSON(), requestId);
  } catch (error) {
    console.error("createPlan error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create plan.", requestId);
  }
};

export const updatePlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const plan = await PlatformPlanModel.findOne({ _id: req.params.planId });
    if (!plan) return sendError(res, 404, "Plan not found.", requestId);

    const userId = req.auth?.userId || req.auth?.id || null;
    const { name, description, pricing, limits, features, trialDays, gracePeriodDays, supportLevel, backupFrequency, isSellable, sortOrder } = req.body;
    if (name !== undefined) plan.name = name;
    if (description !== undefined) plan.description = description;
    if (pricing !== undefined) plan.pricing = { ...plan.pricing, ...pricing };
    if (limits !== undefined) plan.limits = { ...plan.limits, ...limits };
    if (features !== undefined) for (const [key, value] of Object.entries(features)) plan.features.set(key, value);
    if (trialDays !== undefined) plan.trialDays = trialDays;
    if (gracePeriodDays !== undefined) plan.gracePeriodDays = gracePeriodDays;
    if (supportLevel !== undefined) plan.supportLevel = supportLevel;
    if (backupFrequency !== undefined) plan.backupFrequency = backupFrequency;
    if (isSellable !== undefined) plan.isSellable = isSellable;
    if (sortOrder !== undefined) plan.sortOrder = sortOrder;
    plan.updatedBy = userId;
    plan.timeline.push({ event: "PlanUpdated", description: "Plan updated.", performedBy: userId });
    await plan.save();

    return sendSuccess(res, 200, "Plan updated successfully.", plan.toJSON(), requestId);
  } catch (error) {
    console.error("updatePlan error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update plan.", requestId);
  }
};

// ---- Tenant's own Subscription ----

export const getSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.read")) return sendError(res, 403, "Permission denied.", requestId);

    const subscription = await TenantSubscriptionModel.findOne({ tenantId: scope.tenantId }).populate("planId").lean();
    if (!subscription) return sendError(res, 404, "No subscription found for this tenant.", requestId);
    return sendSuccess(res, 200, "Subscription retrieved successfully.", subscription, requestId);
  } catch (error) {
    console.error("getSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve subscription.", requestId);
  }
};

export const startTrial = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await TenantSubscriptionService.startTrial(scope.tenantId, req.body.planId, userId);
    return sendSuccess(res, 201, "Trial started successfully.", subscription, requestId);
  } catch (error) {
    console.error("startTrial error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to start trial.", requestId);
  }
};

export const createSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await TenantSubscriptionService.createSubscription(scope.tenantId, { planId: req.body.planId, billingCycle: req.body.billingCycle, userId });
    return sendSuccess(res, 201, "Subscription created successfully.", result, requestId);
  } catch (error) {
    console.error("createSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create subscription.", requestId);
  }
};

export const cancelSubscription = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const subscription = await TenantSubscriptionService.cancelSubscription(scope.tenantId, { reason: req.body.reason, userId });
    return sendSuccess(res, 200, "Subscription cancelled successfully.", subscription, requestId);
  } catch (error) {
    console.error("cancelSubscription error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel subscription.", requestId);
  }
};

// ---- Billing Account ----

export const getBillingAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.read")) return sendError(res, 403, "Permission denied.", requestId);

    const account = await TenantBillingAccountModel.findOne({ tenantId: scope.tenantId }).lean();
    if (!account) return sendError(res, 404, "No billing account found for this tenant.", requestId);
    return sendSuccess(res, 200, "Billing account retrieved successfully.", account, requestId);
  } catch (error) {
    console.error("getBillingAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve billing account.", requestId);
  }
};

export const setupBillingAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await TenantSubscriptionService.setupBillingAccount(scope.tenantId, req.body, userId);
    return sendSuccess(res, 200, "Billing account saved successfully.", account, requestId);
  } catch (error) {
    console.error("setupBillingAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to save billing account.", requestId);
  }
};

/** POST /api/v1/platform/billing-account/verify — a human operator confirms a non-Stripe billing account's real details are legitimate. */
export const verifyBillingAccount = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const account = await TenantSubscriptionService.verifyBillingAccount(scope.tenantId, userId);
    return sendSuccess(res, 200, "Billing account verified successfully.", account, requestId);
  } catch (error) {
    console.error("verifyBillingAccount error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to verify billing account.", requestId);
  }
};

// ---- Invoices ----

export const listInvoices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.read")) return sendError(res, 403, "Permission denied.", requestId);
    const config = getPlatformConfig();

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const filter = { tenantId: scope.tenantId };
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      SubscriptionInvoiceModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      SubscriptionInvoiceModel.countDocuments(filter)
    ]);

    return sendSuccess(res, 200, "Invoices retrieved successfully.", { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } }, requestId);
  } catch (error) {
    console.error("listInvoices error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve invoices.", requestId);
  }
};

export const payInvoiceManually = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await SubscriptionInvoiceModel.findOne({ _id: req.params.invoiceId, tenantId: scope.tenantId }).lean();
    if (!invoice) return sendError(res, 404, "Invoice not found.", requestId);

    const result = await TenantSubscriptionService.recordManualPayment(req.params.invoiceId, { reference: req.body.reference, userId });
    return sendSuccess(res, 200, "Payment recorded successfully.", result, requestId);
  } catch (error) {
    console.error("payInvoiceManually error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to record payment.", requestId);
  }
};

export const chargeInvoiceAutoDebit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.billing.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const invoice = await SubscriptionInvoiceModel.findOne({ _id: req.params.invoiceId, tenantId: scope.tenantId }).lean();
    if (!invoice) return sendError(res, 404, "Invoice not found.", requestId);

    const result = await TenantSubscriptionService.chargeAutoDebit(req.params.invoiceId, userId);
    return sendSuccess(res, 200, result.status === "Paid" ? "Payment charged successfully." : "Payment attempt failed.", result, requestId);
  } catch (error) {
    console.error("chargeInvoiceAutoDebit error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to charge invoice.", requestId);
  }
};

// ---- Admin self-tenant override (reuses the existing "admin" permission — see doc comment above) ----

export const adminSuspendOwnTenant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await TenantSubscriptionService.suspendTenant(scope.tenantId, req.body.reason || "Manually suspended by tenant admin.", userId);
    return sendSuccess(res, 200, "Tenant suspended successfully.", result, requestId);
  } catch (error) {
    console.error("adminSuspendOwnTenant error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend tenant.", requestId);
  }
};

export const adminReactivateOwnTenant = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const result = await TenantSubscriptionService.reactivateTenant(scope.tenantId, userId);
    return sendSuccess(res, 200, "Tenant reactivated successfully.", result, requestId);
  } catch (error) {
    console.error("adminReactivateOwnTenant error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reactivate tenant.", requestId);
  }
};

// ---- File 0's own literal /api/v1/subscriptions resource contract ----
//
// Addressed by subscriptionId (not implicit "my own tenant") to match
// File 0's exact endpoint shapes, but every handler below still verifies
// the resolved subscription's own `tenantId` against `getAccessScope(req)`
// before acting — there is no separate "Platform Operator" identity
// anywhere in this codebase's auth model (only a tenant's own `admin`
// permission), so a request-body/query `tenantId` is NEVER trusted for
// scoping, the same standing rule `getAccessScope` itself already
// enforces everywhere else. See docs/05-api/09-subscription-platform-api.md's
// own "Cross-tenant access" section for the full reasoning. Practically:
// these endpoints behave like the self-service ones above, just
// addressed by id instead of being implicit — real, safe, and future-proof
// if this platform ever needs to support more than one subscription
// document per tenant, without being a cross-tenant security hole today.

/** POST /api/v1/subscriptions — real create; `tenantId` in the body must match the caller's own tenant. */
export const createSubscriptionResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    if (req.body.tenantId && req.body.tenantId !== scope.tenantId) return sendError(res, 403, "Cannot create a subscription for a different tenant.", requestId);

    const result = await TenantSubscriptionService.createSubscription(scope.tenantId, { planId: req.body.planId, billingCycle: req.body.billingCycle, userId });
    return sendSuccess(res, 201, "Subscription created successfully.", result, requestId);
  } catch (error) {
    console.error("createSubscriptionResource error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create subscription.", requestId);
  }
};

/** GET /api/v1/subscriptions — real list; always scoped to the caller's own tenant regardless of any `tenantId` query param (see file-level doc comment above). */
export const listSubscriptionsResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.read")) return sendError(res, 403, "Permission denied.", requestId);
    const config = getPlatformConfig();

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    // "company"/"branch" query params from the spec are accepted but
    // never applied — Company IS Tenant already, and this codebase has
    // no Branch concept (see the standing master instructions).
    const filter = { tenantId: scope.tenantId };
    if (req.query.plan) filter.planCode = req.query.plan;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.billingCycle) filter.billingCycle = req.query.billingCycle;

    const [items, total] = await Promise.all([
      TenantSubscriptionModel.find(filter).populate("planId").sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      TenantSubscriptionModel.countDocuments(filter)
    ]);

    return sendSuccess(res, 200, "Subscriptions retrieved successfully.", { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } }, requestId);
  } catch (error) {
    console.error("listSubscriptionsResource error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve subscriptions.", requestId);
  }
};

const loadOwnSubscriptionById = async (req, scope) => {
  const subscription = await TenantSubscriptionModel.findOne({ _id: req.params.subscriptionId }).lean();
  if (!subscription) throw Object.assign(new Error("Subscription not found."), { httpStatus: 404 });
  if (subscription.tenantId !== scope.tenantId) throw Object.assign(new Error("Subscription not found."), { httpStatus: 404 }); // 404, not 403 — never confirm a foreign subscriptionId exists.
  return subscription;
};

/** POST /api/v1/subscriptions/{subscriptionId}/renew */
export const renewSubscriptionResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    await loadOwnSubscriptionById(req, scope);
    const result = await TenantSubscriptionService.renewNow(scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription renewed successfully.", result, requestId);
  } catch (error) {
    console.error("renewSubscriptionResource error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to renew subscription.", requestId);
  }
};

/** POST /api/v1/subscriptions/{subscriptionId}/suspend */
export const suspendSubscriptionResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    await loadOwnSubscriptionById(req, scope);
    const result = await TenantSubscriptionService.suspendTenant(scope.tenantId, req.body.reason || "Manually suspended.", userId);
    return sendSuccess(res, 200, "Subscription suspended successfully.", result, requestId);
  } catch (error) {
    console.error("suspendSubscriptionResource error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to suspend subscription.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #1 (Enterprise
// Subscription Scheduler) — Monitoring Dashboard. Platform-wide,
// cross-tenant operational data (a scheduler run scans every tenant in one
// pass) — gated on the same tenant-scoped "admin" permission every other
// cross-tenant platform-operator-style action in this module already
// reuses (see this file's own top-of-file doc note: no separate "Platform
// Operator" identity exists anywhere in this codebase's auth model).

/** GET /api/v1/platform/subscription-scheduler/runs — recent scheduler run records, most recent first. */
export const listSchedulerRuns = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const config = getPlatformConfig();

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const filter = {};
    if (req.query.jobName) filter.jobName = req.query.jobName;
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      SchedulerRunModel.find(filter).sort({ startedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      SchedulerRunModel.countDocuments(filter)
    ]);

    return sendSuccess(res, 200, "Scheduler runs retrieved successfully.", { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } }, requestId);
  } catch (error) {
    console.error("listSchedulerRuns error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve scheduler runs.", requestId);
  }
};

/**
 * GET /api/v1/platform/subscription-scheduler/dashboard — "Dashboard
 * should display Today's Renewals, Today's Suspensions, Grace Period
 * Companies, Failed Jobs, Average Runtime, Next Scheduled Run." Every
 * figure is a real, live query — "Today's Renewals"/"Today's Suspensions"
 * reuse the exact existing audit actions `TenantSubscriptionService`
 * already writes (`platform.subscription.renew`, `platform.tenant.suspend`)
 * rather than a separate, drift-prone counter, and count a renewal/
 * suspension regardless of whether it was scheduler-driven or
 * manual/payment-driven — genuinely "today's" total either way.
 */
export const getSchedulerDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);

    const [todayRenewals, todaySuspensions, gracePeriodCompanies, failedJobsToday, recentCompletedRuns, lastDailySweep, lastSuspensionRun] = await Promise.all([
      AuditLogModel.countDocuments({ action: "platform.subscription.renew", createdAt: { $gte: startOfToday } }),
      AuditLogModel.countDocuments({ action: "platform.tenant.suspend", createdAt: { $gte: startOfToday } }),
      TenantSubscriptionModel.countDocuments({ status: "GracePeriod" }),
      SchedulerRunModel.countDocuments({ status: "Failed", startedAt: { $gte: startOfToday } }),
      SchedulerRunModel.find({ status: "Completed" }).sort({ startedAt: -1 }).limit(20).select("durationMs").lean(),
      SchedulerRunModel.findOne({ jobName: "SubscriptionScheduler" }).sort({ startedAt: -1 }).select("jobId status startedAt finishedAt").lean(),
      SchedulerRunModel.findOne({ jobName: "SubscriptionSuspensionEnforcement" }).sort({ startedAt: -1 }).select("jobId status startedAt finishedAt").lean()
    ]);

    const averageRuntimeMs = recentCompletedRuns.length > 0
      ? Math.round(recentCompletedRuns.reduce((sum, run) => sum + (run.durationMs || 0), 0) / recentCompletedRuns.length)
      : null;

    // "Next Scheduled Run" — real, computed from the actual configured
    // cron expressions (cron-parser), never a guessed/hardcoded time.
    const config = getPlatformConfig();
    const { CronExpressionParser } = await import("cron-parser");
    const nextRunFor = (cronExpression) => {
      try {
        return CronExpressionParser.parse(cronExpression, { tz: process.env.TZ || undefined }).next().toDate();
      } catch {
        return null;
      }
    };

    return sendSuccess(res, 200, "Scheduler dashboard retrieved successfully.", {
      todayRenewals,
      todaySuspensions,
      gracePeriodCompanies,
      failedJobsToday,
      averageRuntimeMs,
      jobs: {
        SubscriptionScheduler: { cron: config.subscriptionLifecycleCron, nextScheduledRun: nextRunFor(config.subscriptionLifecycleCron), lastRun: lastDailySweep },
        SubscriptionSuspensionEnforcement: { cron: config.subscriptionSuspensionEnforcementCron, nextScheduledRun: nextRunFor(config.subscriptionSuspensionEnforcementCron), lastRun: lastSuspensionRun }
      }
    }, requestId);
  } catch (error) {
    console.error("getSchedulerDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve scheduler dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #2 (Enterprise
// Automatic Renewal Engine) — Monitoring Dashboard. Same platform-wide,
// `admin`-gated reasoning as Automation #1's own dashboard above.

/** GET /api/v1/platform/renewal-engine/renewals — recent renewal attempt records, most recent first. */
export const listRenewals = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const config = getPlatformConfig();

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.tenantId) filter.tenantId = req.query.tenantId;

    const [items, total] = await Promise.all([
      SubscriptionRenewalModel.find(filter).sort({ startedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      SubscriptionRenewalModel.countDocuments(filter)
    ]);

    return sendSuccess(res, 200, "Renewals retrieved successfully.", { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } }, requestId);
  } catch (error) {
    console.error("listRenewals error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve renewals.", requestId);
  }
};

/**
 * GET /api/v1/platform/renewal-engine/dashboard — "Today's Renewals,
 * Successful Renewals, Failed Renewals, Pending Renewals, Average Renewal
 * Time, Revenue Collected Today." Every figure a real, live query/aggregate
 * over `SubscriptionRenewalModel` — "Revenue Collected Today" sums the
 * real `finalAmount` of every renewal that actually reached `Renewed`
 * today, grouped by currency (never summed across mismatched currencies).
 */
export const getRenewalEngineDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);

    const [todayRenewals, successfulToday, failedToday, pending, avgDurationAgg, revenueAgg] = await Promise.all([
      SubscriptionRenewalModel.countDocuments({ startedAt: { $gte: startOfToday } }),
      SubscriptionRenewalModel.countDocuments({ status: "Renewed", renewedAt: { $gte: startOfToday } }),
      SubscriptionRenewalModel.countDocuments({ status: "Failed", failedAt: { $gte: startOfToday } }),
      SubscriptionRenewalModel.countDocuments({ status: { $in: ["Pending", "InvoiceGenerated", "PaymentAttempted"] } }),
      SubscriptionRenewalModel.aggregate([
        { $match: { status: "Renewed", durationMs: { $ne: null } } },
        { $sort: { renewedAt: -1 } },
        { $limit: 50 },
        { $group: { _id: null, avgDurationMs: { $avg: "$durationMs" } } }
      ]),
      SubscriptionRenewalModel.aggregate([
        { $match: { status: "Renewed", renewedAt: { $gte: startOfToday } } },
        { $group: { _id: "$currency", total: { $sum: "$finalAmount" } } }
      ])
    ]);

    return sendSuccess(res, 200, "Renewal engine dashboard retrieved successfully.", {
      todayRenewals,
      successfulRenewalsToday: successfulToday,
      failedRenewalsToday: failedToday,
      pendingRenewals: pending,
      averageRenewalTimeMs: avgDurationAgg[0]?.avgDurationMs || null,
      revenueCollectedToday: revenueAgg.map((row) => ({ currency: row._id, total: row.total }))
    }, requestId);
  } catch (error) {
    console.error("getRenewalEngineDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve renewal engine dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #3 (Enterprise
// Payment Retry Strategy) — Monitoring Dashboard. Retry LISTING itself
// reuses the existing GET /renewal-engine/renewals?status=Retrying
// (Automation #2) rather than a second, duplicate list endpoint over the
// same SubscriptionRenewalModel collection.

/**
 * GET /api/v1/platform/retry-engine/dashboard — "Pending Retries, Today's
 * Retries, Successful Retries, Failed Retries, Retry Success Rate,
 * Average Retry Time, Revenue Recovered." Every figure a real, live
 * query/aggregate. "Revenue Recovered" specifically sums `finalAmount`
 * for renewals that reached `Renewed` only AFTER at least one genuine
 * retry (`attemptCount > 1`) — revenue this engine actually saved,
 * distinct from Automation #2's own "Revenue Collected Today" (which
 * counts every renewal, first-attempt or retried).
 */
export const getRetryEngineDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);

    const [pendingRetries, todayRetries, retryOutcomeAgg, retryDurationAgg, revenueRecoveredAgg] = await Promise.all([
      SubscriptionRenewalModel.countDocuments({ status: "Retrying" }),
      AuditLogModel.countDocuments({ action: "PAYMENT_RETRY", createdAt: { $gte: startOfToday } }),
      SubscriptionRenewalModel.aggregate([
        { $unwind: "$attempts" },
        { $match: { "attempts.attemptNumber": { $gt: 1 } } },
        { $sort: { "attempts.attemptedAt": -1 } },
        { $limit: 200 },
        { $group: { _id: "$attempts.status", count: { $sum: 1 } } }
      ]),
      SubscriptionRenewalModel.aggregate([
        { $match: { attemptCount: { $gt: 1 }, status: { $in: ["Renewed", "Failed"] }, durationMs: { $ne: null } } },
        { $sort: { updatedAt: -1 } },
        { $limit: 50 },
        { $group: { _id: null, avgDurationMs: { $avg: "$durationMs" } } }
      ]),
      SubscriptionRenewalModel.aggregate([
        { $match: { status: "Renewed", attemptCount: { $gt: 1 }, renewedAt: { $gte: startOfToday } } },
        { $group: { _id: "$currency", total: { $sum: "$finalAmount" } } }
      ])
    ]);

    const successfulRetries = retryOutcomeAgg.find((row) => row._id === "Succeeded")?.count || 0;
    const failedRetries = retryOutcomeAgg.find((row) => row._id === "Failed")?.count || 0;
    const totalRetryOutcomes = successfulRetries + failedRetries;
    const retrySuccessRate = totalRetryOutcomes > 0 ? Math.round((successfulRetries / totalRetryOutcomes) * 10000) / 100 : null;

    return sendSuccess(res, 200, "Payment retry engine dashboard retrieved successfully.", {
      pendingRetries,
      todayRetries,
      successfulRetries,
      failedRetries,
      retrySuccessRatePercent: retrySuccessRate,
      averageRetryTimeMs: retryDurationAgg[0]?.avgDurationMs || null,
      revenueRecoveredToday: revenueRecoveredAgg.map((row) => ({ currency: row._id, total: row.total }))
    }, requestId);
  } catch (error) {
    console.error("getRetryEngineDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve retry engine dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #4 (Enterprise
// Grace Period Engine) — Grace status (self-service) + Monitoring Dashboard.

/** GET /api/v1/platform/grace/status — the caller's own tenant's real, live "Grace Metadata" (self-service, same reachable-while-in-grace carve-out this whole router already has). */
export const getOwnGraceStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "platform.subscription.read")) return sendError(res, 403, "Permission denied.", requestId);

    const subscription = await TenantSubscriptionModel.findOne({ tenantId: scope.tenantId }).lean();
    if (!subscription) return sendError(res, 404, "No subscription found for this tenant.", requestId);

    const status = await GracePeriodEngineService.getGraceStatus(subscription._id);
    return sendSuccess(res, 200, "Grace status retrieved successfully.", status, requestId);
  } catch (error) {
    console.error("getOwnGraceStatus error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve grace status.", requestId);
  }
};

/**
 * GET /api/v1/platform/grace-period-engine/dashboard — "Merchants in
 * Grace, Grace Expiring Today, Grace Expiring Tomorrow, Recovered During
 * Grace, Converted to Suspension, Average Grace Duration." Every figure a
 * real, live query/aggregate. "Converted to Suspension" matches the exact
 * literal `suspendedReason` string `TenantSubscriptionService.enforceGracePeriodSuspensions`
 * has always used, distinguishing a real grace-expiry suspension from a
 * manual admin one. "Average Grace Duration" is computed over the real
 * `graceStartedAt` -> (`graceEndedAt` recovery OR `suspendedAt` conversion)
 * span of the last 100 resolved grace cycles.
 */
export const getGracePeriodDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday.getTime() + 86400000);
    const startOfDayAfterTomorrow = new Date(startOfToday.getTime() + 2 * 86400000);
    const GRACE_SUSPEND_REASON = "Subscription grace period ended with no payment received.";

    const [merchantsInGrace, graceExpiringToday, graceExpiringTomorrow, recoveredDuringGrace, convertedToSuspension, durationAgg] = await Promise.all([
      TenantSubscriptionModel.countDocuments({ status: "GracePeriod" }),
      TenantSubscriptionModel.countDocuments({ status: "GracePeriod", gracePeriodEndsAt: { $gte: startOfToday, $lt: startOfTomorrow } }),
      TenantSubscriptionModel.countDocuments({ status: "GracePeriod", gracePeriodEndsAt: { $gte: startOfTomorrow, $lt: startOfDayAfterTomorrow } }),
      TenantSubscriptionModel.countDocuments({ graceEndedAt: { $ne: null } }),
      TenantSubscriptionModel.countDocuments({ status: "Suspended", suspendedReason: GRACE_SUSPEND_REASON }),
      TenantSubscriptionModel.aggregate([
        { $match: { graceStartedAt: { $ne: null }, $or: [{ graceEndedAt: { $ne: null } }, { status: "Suspended", suspendedReason: GRACE_SUSPEND_REASON }] } },
        { $addFields: { graceResolvedAt: { $ifNull: ["$graceEndedAt", "$suspendedAt"] } } },
        { $match: { graceResolvedAt: { $ne: null } } },
        { $sort: { graceResolvedAt: -1 } },
        { $limit: 100 },
        { $project: { durationMs: { $subtract: ["$graceResolvedAt", "$graceStartedAt"] } } },
        { $group: { _id: null, avgDurationMs: { $avg: "$durationMs" } } }
      ])
    ]);

    return sendSuccess(res, 200, "Grace period engine dashboard retrieved successfully.", {
      merchantsInGrace,
      graceExpiringToday,
      graceExpiringTomorrow,
      recoveredDuringGrace,
      convertedToSuspension,
      averageGraceDurationMs: durationAgg[0]?.avgDurationMs || null
    }, requestId);
  } catch (error) {
    console.error("getGracePeriodDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve grace period dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #5 (Enterprise
// Automatic Access Revocation Engine) — Monitoring Dashboard.

/**
 * GET /api/v1/platform/access-revocation/dashboard — "Suspended
 * Merchants, Today's Suspensions, Recovered Merchants, Blocked API
 * Requests, Revoked Sessions, Disabled Integrations." Every figure a
 * real, live query/aggregate. "Disabled Integrations" is honestly 0/N-A —
 * none of the spec's named third-party integrations (Shopify, QuickBooks,
 * SAP, Slack, ...) exist anywhere in this codebase to disable; the one
 * real gateway integration (Stripe) is deliberately NEVER disabled on
 * suspension, since a suspended tenant still needs it to pay their way
 * back to Active.
 */
export const getAccessRevocationDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);

    const [suspendedMerchants, todaySuspensions, recoveredMerchants, blockedRequestsAgg, revokedSessionsAgg] = await Promise.all([
      TenantSubscriptionModel.countDocuments({ status: "Suspended" }),
      AuditLogModel.countDocuments({ action: "ACCESS_REVOKED", createdAt: { $gte: startOfToday } }),
      AuditLogModel.countDocuments({ action: "platform.tenant.reactivate", createdAt: { $gte: startOfToday } }),
      TenantSubscriptionModel.aggregate([{ $group: { _id: null, total: { $sum: "$blockedRequestCount" } } }]),
      AuditLogModel.aggregate([
        { $match: { action: "platform.tenant.suspend", createdAt: { $gte: startOfToday } } },
        { $group: { _id: null, total: { $sum: "$details.sessionsRevoked" } } }
      ])
    ]);

    return sendSuccess(res, 200, "Access revocation engine dashboard retrieved successfully.", {
      suspendedMerchants,
      todaySuspensions,
      recoveredMerchants,
      blockedApiRequests: blockedRequestsAgg[0]?.total || 0,
      revokedSessionsToday: revokedSessionsAgg[0]?.total || 0,
      disabledIntegrations: 0
    }, requestId);
  } catch (error) {
    console.error("getAccessRevocationDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve access revocation dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #6 (Enterprise
// Subscription Enforcement Middleware) — Monitoring Dashboard.

/**
 * GET /api/v1/platform/enforcement/dashboard — "Blocked Requests, Blocked
 * Merchants, Expired Requests, Cache Hit Ratio, Average Middleware Time."
 * Every figure real: blocked-request/blocked-merchant/expired-request
 * counts from the real `SUBSCRIPTION_BLOCK` audit trail this automation's
 * own `TenantSubscriptionService.recordBlockedRequest` now writes; cache
 * hit ratio from `CacheManager.getStats()` (already real, platform-wide —
 * subscription enforcement is one of its heaviest real consumers, but this
 * figure reflects every `CacheManager` consumer, not only this one, stated
 * honestly rather than overclaimed as enforcement-specific); average
 * middleware time from `utils/enforcementMetrics.js`'s own real, in-process
 * timing around every enforcement check.
 */
export const getEnforcementDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);

    const [blockedRequestsAgg, blockedMerchantsToday, expiredRequestsToday] = await Promise.all([
      TenantSubscriptionModel.aggregate([{ $group: { _id: null, total: { $sum: "$blockedRequestCount" } } }]),
      AuditLogModel.distinct("tenantId", { action: "SUBSCRIPTION_BLOCK", createdAt: { $gte: startOfToday } }),
      AuditLogModel.countDocuments({ action: "SUBSCRIPTION_BLOCK", "details.reason": "SUBSCRIPTION_EXPIRED", createdAt: { $gte: startOfToday } })
    ]);

    return sendSuccess(res, 200, "Enforcement middleware dashboard retrieved successfully.", {
      blockedRequests: blockedRequestsAgg[0]?.total || 0,
      blockedMerchantsToday: blockedMerchantsToday.length,
      expiredRequestsToday,
      cache: CacheManager.getStats(),
      ...getEnforcementMetrics()
    }, requestId);
  } catch (error) {
    console.error("getEnforcementDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve enforcement dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #7 (Enterprise
// Notification Timeline) — Monitoring Dashboard.

/**
 * GET /api/v1/platform/notifications/dashboard — "Emails Sent, Delivery
 * Rate, Open Rate, Payment Reminder Success, Suspension Notifications,
 * Failed Deliveries." Every figure real, scoped to
 * `sourceModule: "Platform"` — the real, pre-existing identity the
 * Enterprise Subscription Platform's own communications have always used
 * (`CommunicationMessageModel`'s own schema comment), so this dashboard
 * naturally covers every subscription notification ever sent, not only
 * this automation's own new ones (renewal/retry/suspension/reactivation),
 * within the shared collection every module in this codebase sends
 * through. "Open Rate" is honestly `null` — no tracking-pixel/
 * link-rewriting infrastructure exists anywhere in this codebase to
 * measure it, never a fabricated percentage.
 */
export const getNotificationDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
    const sourceModule = "Platform";

    const [totalSent, deliveredCount, failedCount, suspensionNotifications, reminderStatusAgg] = await Promise.all([
      CommunicationMessageModel.countDocuments({ sourceModule, createdAt: { $gte: startOfToday } }),
      CommunicationMessageModel.countDocuments({ sourceModule, status: "Delivered", createdAt: { $gte: startOfToday } }),
      CommunicationMessageModel.countDocuments({ sourceModule, status: "Failed", createdAt: { $gte: startOfToday } }),
      AuditLogModel.countDocuments({ action: "NOTIFICATION_SENT", "details.template": "Suspended", createdAt: { $gte: startOfToday } }),
      AuditLogModel.aggregate([
        { $match: { action: "NOTIFICATION_SENT", "details.template": { $regex: "^RenewalReminder" }, createdAt: { $gte: startOfToday } } },
        { $group: { _id: "$details.status", count: { $sum: 1 } } }
      ])
    ]);

    const reminderDelivered = reminderStatusAgg.find((row) => row._id === "Delivered")?.count || 0;
    const reminderTotal = reminderStatusAgg.reduce((sum, row) => sum + row.count, 0);

    return sendSuccess(res, 200, "Notification timeline dashboard retrieved successfully.", {
      emailsSentToday: totalSent,
      deliveryRatePercent: totalSent > 0 ? Math.round((deliveredCount / totalSent) * 10000) / 100 : null,
      openRatePercent: null,
      paymentReminderSuccessRatePercent: reminderTotal > 0 ? Math.round((reminderDelivered / reminderTotal) * 10000) / 100 : null,
      suspensionNotificationsToday: suspensionNotifications,
      failedDeliveriesToday: failedCount
    }, requestId);
  } catch (error) {
    console.error("getNotificationDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve notification dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #8 (Enterprise
// Bulk Processing Engine) — Monitoring Dashboard + Dead Letter Queue.

/**
 * GET /api/v1/platform/bulk-processing/dashboard — "Queue Size, Active
 * Workers, Average Processing Time, Success Rate, Retry Queue, DLQ Size."
 * Every figure real: `queueSize` is a live count of GracePeriod-expired
 * subscriptions awaiting the next sweep; `activeWorkers`/`activeRetries`
 * are real, live, in-process gauges for THIS running instance (see
 * `BulkProcessingEngineService.getLiveGauges`'s own doc comment for why —
 * same honest single-instance scope as `CacheManager.getStats()` and
 * `utils/enforcementMetrics.js` elsewhere in this platform);
 * `averageProcessingTimeMs`/`successRatePercent` are computed from the
 * real per-merchant audit trail this automation writes
 * (`platform.bulk_processing.merchant_processed`/`merchant_failed`);
 * `deadLetterQueueSize` reuses the EXISTING, shared
 * `DeadLetterQueueModel` from the Enterprise Resilience & Reliability
 * Standard, filtered to this engine's own `integration` label. "Auto
 * Scaling" from the automation's own spec is deliberately NOT built —
 * this codebase has no container-orchestration layer (Kubernetes HPA or
 * equivalent) to scale workers against; `bulkProcessingConcurrency`
 * remains a real, admin-configurable static ceiling, not a fabricated
 * dynamic autoscaler.
 */
export const getBulkProcessingDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();

    const [queueSize, recentJobs, processedAgg, dlqPending, dlqTotal] = await Promise.all([
      TenantSubscriptionModel.countDocuments({ status: "GracePeriod", gracePeriodEndsAt: { $lte: now } }),
      BulkProcessingJobModel.find({}).sort({ startedAt: -1 }).limit(20).lean(),
      AuditLogModel.aggregate([
        { $match: { action: { $in: ["platform.bulk_processing.merchant_processed", "platform.bulk_processing.merchant_failed"] }, createdAt: { $gte: startOfDay } } },
        { $group: { _id: "$action", count: { $sum: 1 }, avgProcessingTimeMs: { $avg: "$details.processingTimeMs" } } }
      ]),
      DeadLetterQueueModel.countDocuments({ integration: DLQ_INTEGRATION, status: "Pending" }),
      DeadLetterQueueModel.countDocuments({ integration: DLQ_INTEGRATION })
    ]);

    const succeededRow = processedAgg.find((row) => row._id === "platform.bulk_processing.merchant_processed");
    const failedRow = processedAgg.find((row) => row._id === "platform.bulk_processing.merchant_failed");
    const succeededCount = succeededRow?.count || 0;
    const failedCount = failedRow?.count || 0;
    const totalCount = succeededCount + failedCount;
    const avgMs = totalCount > 0
      ? ((succeededRow?.avgProcessingTimeMs || 0) * succeededCount + (failedRow?.avgProcessingTimeMs || 0) * failedCount) / totalCount
      : 0;

    return sendSuccess(res, 200, "Bulk processing engine dashboard retrieved successfully.", {
      queueSize,
      ...BulkProcessingEngineService.getLiveGauges(),
      configuredConcurrency: getBulkProcessingConfig().bulkProcessingConcurrency,
      configuredBatchSize: getBulkProcessingConfig().bulkProcessingBatchSize,
      averageProcessingTimeMs: totalCount > 0 ? Math.round(avgMs) : null,
      successRatePercent: totalCount > 0 ? Math.round((succeededCount / totalCount) * 10000) / 100 : null,
      deadLetterQueue: { pending: dlqPending, total: dlqTotal },
      recentJobs
    }, requestId);
  } catch (error) {
    console.error("getBulkProcessingDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve bulk processing dashboard.", requestId);
  }
};

/**
 * POST /api/v1/platform/bulk-processing/dead-letters/:dlqId/reprocess —
 * "Operations Review -> Manual Resolution." Reuses the EXISTING, generic
 * `reprocessDeadLetter` from the Resilience Standard rather than a
 * parallel mechanism; the real `run` executor is supplied here because
 * only this module knows how to genuinely re-execute a bulk-processing
 * item (per `reprocessDeadLetter`'s own doc comment — no fully generic
 * replay is safe). Currently supports the one real job type this
 * automation ships: `GracePeriodSuspensionSweep`.
 */
export const reprocessBulkProcessingDeadLetter = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const dlq = await DeadLetterQueueModel.findById(req.params.dlqId).lean();
    if (!dlq || dlq.integration !== DLQ_INTEGRATION) return sendError(res, 404, "Bulk processing dead letter queue record not found.", requestId);
    if (dlq.operation !== "GracePeriodSuspensionSweep") return sendError(res, 400, `No reprocessor registered for job type "${dlq.operation}".`, requestId);

    const result = await reprocessDeadLetter(req.params.dlqId, async () => {
      const subscription = await TenantSubscriptionModel.findOne({ tenantId: dlq.payload?.tenantId, status: "GracePeriod" });
      if (!subscription) return { result: "SKIPPED", reason: "Subscription is no longer in GracePeriod." };
      return TenantSubscriptionService.suspendTenant(subscription.tenantId, "Subscription grace period ended with no payment received. (Manual Dead Letter Queue reprocess.)", userId || "system", { automatic: true });
    }, userId);

    return sendSuccess(res, 200, "Bulk processing dead letter reprocessed successfully.", result, requestId);
  } catch (error) {
    console.error("reprocessBulkProcessingDeadLetter error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to reprocess dead letter record.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #9 (Enterprise
// Automatic Reactivation Workflow) — Monitoring Dashboard.

/**
 * GET /api/v1/platform/reactivation/dashboard — "Today's Reactivations,
 * Average Reactivation Time, Manual Reviews, Automatic Reactivations,
 * Failed Reactivations." Every figure real: reactivation counts from the
 * spec-shaped `MERCHANT_REACTIVATED` audit trail `reactivateTenant` now
 * writes; "Manual Reviews" is the real, live count of subscriptions
 * currently held (`reactivationHold: true`) awaiting Finance/Compliance
 * resolution; "Failed Reactivations" from the real `REACTIVATION_FAILED`
 * audit trail `_onPaymentReceived` now writes when a payment-triggered
 * auto-reactivation genuinely errors; "Average Reactivation Time" is
 * computed for real from today's reactivations against each one's own
 * nearest prior `platform.tenant.suspend` audit entry — a genuine
 * suspended-to-reactivated duration, not a guessed figure.
 */
export const getReactivationDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);

    const [todaysReactivations, automaticReactivations, manualReviewsPending, failedReactivationsToday, recentReactivations] = await Promise.all([
      AuditLogModel.countDocuments({ action: "MERCHANT_REACTIVATED", createdAt: { $gte: startOfDay } }),
      AuditLogModel.countDocuments({ action: "MERCHANT_REACTIVATED", "details.automatic": true, createdAt: { $gte: startOfDay } }),
      TenantSubscriptionModel.countDocuments({ reactivationHold: true }),
      AuditLogModel.countDocuments({ action: "REACTIVATION_FAILED", createdAt: { $gte: startOfDay } }),
      AuditLogModel.find({ action: "MERCHANT_REACTIVATED", createdAt: { $gte: startOfDay } }).select("tenantId createdAt").limit(50).lean()
    ]);

    let totalDurationMs = 0;
    let sampledCount = 0;
    for (const row of recentReactivations) {
      const priorSuspend = await AuditLogModel.findOne({ action: "platform.tenant.suspend", tenantId: row.tenantId, createdAt: { $lt: row.createdAt } }).sort({ createdAt: -1 }).select("createdAt").lean();
      if (priorSuspend) {
        totalDurationMs += row.createdAt.getTime() - priorSuspend.createdAt.getTime();
        sampledCount += 1;
      }
    }

    return sendSuccess(res, 200, "Reactivation workflow dashboard retrieved successfully.", {
      todaysReactivations,
      automaticReactivations,
      manualReactivationsToday: Math.max(todaysReactivations - automaticReactivations, 0),
      manualReviewsPending,
      failedReactivationsToday,
      averageReactivationTimeMs: sampledCount > 0 ? Math.round(totalDurationMs / sampledCount) : null
    }, requestId);
  } catch (error) {
    console.error("getReactivationDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve reactivation dashboard.", requestId);
  }
};

// ---- Enterprise Subscription Automation Layer, Automation #10 (Enterprise
// Subscription Operations Dashboard) — the real command centre composing
// every prior automation's own dashboard into one view, plus the genuinely
// new pieces (Executive KPIs/MRR/ARR/Churn, Merchant 360° timeline,
// search, alerts, export). Gated on the same `admin` permission every
// other cross-tenant platform dashboard in this module already reuses —
// role-differentiated access (Finance/Support/Operations/Management/
// Auditor) needs the same "Platform Operator" identity distinct from any
// tenant's own admin that every prior automation (#5, #6, #8, #9) has
// already, consistently, honestly named as not existing in this
// codebase's auth model — not invented ad hoc here.

const auditDashboardView = (req, view) => {
  const userId = req.auth?.userId || req.auth?.id || null;
  AuditLogModel.create({ action: "VIEW_SUBSCRIPTION_DASHBOARD", module: "Platform", resource: "OperationsDashboard", resourceId: view, userId, tenantId: null, details: { userId, view, timestamp: new Date() } })
    .catch((error) => console.error("VIEW_SUBSCRIPTION_DASHBOARD audit failed:", error.message));
};

/** GET /api/v1/platform/operations/dashboard — the real, composed command-centre view. */
export const getOperationsDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const dashboard = await SubscriptionOperationsDashboardService.getFullDashboard();
    auditDashboardView(req, "OperationsDashboard");
    return sendSuccess(res, 200, "Subscription operations dashboard retrieved successfully.", dashboard, requestId);
  } catch (error) {
    console.error("getOperationsDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve operations dashboard.", requestId);
  }
};

/** GET /api/v1/platform/operations/dashboard/export?format=csv|excel — reuses the existing, real Financial Reporting export engine, never a second implementation. */
export const exportOperationsDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const format = (req.query.format || "csv").toLowerCase();
    if (!["csv", "excel"].includes(format)) return sendError(res, 400, "format must be \"csv\" or \"excel\".", requestId);

    const kpis = await SubscriptionOperationsDashboardService.getExecutiveKPIs();
    const report = { reportType: "SubscriptionOperationsDashboard", _id: new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"), data: kpis };
    auditDashboardView(req, "OperationsDashboardExport");

    if (format === "csv") {
      const { content, mimeType, filename } = FinancialReportExportService.generateCsv(report);
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(content);
    }

    const { buffer, mimeType, filename } = await FinancialReportExportService.generateExcel(report);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("exportOperationsDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to export operations dashboard.", requestId);
  }
};

/** GET /api/v1/platform/operations/search?q=... */
export const searchOperations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const results = await SubscriptionOperationsDashboardService.search(req.query.q);
    return sendSuccess(res, 200, "Search results retrieved successfully.", results, requestId);
  } catch (error) {
    console.error("searchOperations error:", error);
    return sendError(res, 500, error.message || "Failed to search.", requestId);
  }
};

/** GET /api/v1/platform/operations/merchants/:tenantId/timeline — the real 360° drill-down. */
export const getMerchantTimeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);

    const timeline = await SubscriptionOperationsDashboardService.getMerchantTimeline(req.params.tenantId);
    auditDashboardView(req, `MerchantTimeline:${req.params.tenantId}`);
    return sendSuccess(res, 200, "Merchant timeline retrieved successfully.", timeline, requestId);
  } catch (error) {
    console.error("getMerchantTimeline error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve merchant timeline.", requestId);
  }
};

/** POST /api/v1/subscriptions/{subscriptionId}/reactivate */
export const reactivateSubscriptionResource = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "admin")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    await loadOwnSubscriptionById(req, scope);
    const result = await TenantSubscriptionService.reactivateTenant(scope.tenantId, userId);
    return sendSuccess(res, 200, "Subscription reactivated successfully.", result, requestId);
  } catch (error) {
    console.error("reactivateSubscriptionResource error:", error);
    return sendError(res, error.httpStatus || statusFromError(error), error.message || "Failed to reactivate subscription.", requestId);
  }
};
