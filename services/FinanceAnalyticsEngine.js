import FinanceOperationsSummaryModel from "../models/FinanceOperationsSummaryModel.js";
import DashboardAlertModel from "../models/DashboardAlertModel.js";
import DashboardPreferenceModel from "../models/DashboardPreferenceModel.js";
import ExpenseModel from "../models/ExpenseModel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import FinancialReportService from "./FinancialReportService.js";
import KPIEngine from "./KPIEngine.js";
import CacheManager from "../utils/cacheManager.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";

const todayStr = () => new Date().toISOString().slice(0, 10);
const cacheKey = (type, tenantId, suffix = "") =>
  `finance-dashboard:${type}:${tenantId}${suffix ? `:${suffix}` : ""}`;
const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

const PERIOD_DAYS = { Today: 1, Daily: 1, Weekly: 7, "7 Days": 7, Monthly: 30, "30 Days": 30, Quarterly: 90, "90 Days": 90, Yearly: 365 };

/**
 * Finance Module Part 25 — Enterprise Financial Dashboard. Mirrors
 * VisaAnalyticsEngine.js's own proven shape exactly: a persisted daily
 * summary (FinanceOperationsSummaryModel, refreshed by KPIEngine),
 * CacheManager-wrapped per-dashboard-type reshaping methods, and a
 * background "never aggregate transactional tables inline on a
 * dashboard request" refresh via queueMicrotask. Not a second, parallel
 * dashboard system.
 */
class FinanceAnalyticsEngine {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    // Real events already published across the prior Finance Parts that
    // signal "a metric this dashboard shows may have changed."
    const refreshEvents = [
      "PaymentCaptured",
      "PaymentAllocated",
      "PaymentRefunded",
      "ReceivablePaid",
      "ReceivableCreated",
      "PayablePaid",
      "PayableCreated",
      "InvoicePaid",
      "InvoiceOverdue",
      "BalanceUpdated",
      "JournalPosted",
      "ExpenseApproved",
      "BudgetExceeded",
    ];

    refreshEvents.forEach((eventName) =>
      subscribeEvent(eventName, ({ tenantId } = {}) => {
        if (!tenantId) return;
        queueMicrotask(() =>
          KPIEngine.refreshFinanceSummary({ tenantId })
            .catch((error) => console.error("Finance dashboard refresh failed:", error))
        );
      })
    );
  }

  static async ensureSummary({ tenantId }) {
    const date = todayStr();
    let summary = await FinanceOperationsSummaryModel.findOne({ tenantId, summaryDate: date }).lean();
    if (!summary) {
      // Dashboard requests must never aggregate transactional tables. An
      // event or scheduled worker creates the missing read model
      // asynchronously — see KPIEngine.refreshFinanceSummary.
      queueMicrotask(() => KPIEngine.refreshFinanceSummary({ tenantId })
        .catch((error) => console.error("Initial Finance analytics refresh failed:", error)));
    }
    return summary || {
      tenantId,
      summaryDate: date,
      metrics: {},
      kpis: {},
      alerts: [],
      generatedAt: null,
      pendingRefresh: true,
    };
  }

  static async getSummary({ tenantId }) {
    const key = cacheKey("summary", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => this.ensureSummary({ tenantId }));
    return { summary: data, fromCache };
  }

  static async executiveDashboard({ tenantId }) {
    const key = cacheKey("executive", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        cashToday: m.cashToday || 0,
        outstandingAR: m.outstandingAR || 0,
        outstandingAP: m.outstandingAP || 0,
        todaysRevenue: m.todaysRevenue || 0,
        todaysExpenses: m.todaysExpenses || 0,
        netCashFlowToday: m.netCashFlowToday || 0,
        overdueInvoices: m.overdueReceivables || 0,
        kpis: summary.kpis || {},
        alertCount: (summary.alerts || []).filter((a) => a.status !== "Resolved").length,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async cfoDashboard({ tenantId }) {
    const key = cacheKey("cfo", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        cashToday: m.cashToday || 0,
        outstandingAR: m.outstandingAR || 0,
        outstandingAP: m.outstandingAP || 0,
        todaysRevenue: m.todaysRevenue || 0,
        todaysExpenses: m.todaysExpenses || 0,
        overdueInvoices: m.overdueReceivables || 0,
        bankBalance: m.bankBalance || 0,
        fxExposure: m.fxExposureLevel || "Low",
        fxExposureTotal: m.fxExposureTotal || 0,
        workingCapital: summary.kpis?.workingCapital || 0,
        currentRatio: summary.kpis?.currentRatio || null,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async treasuryDashboard({ tenantId }) {
    const key = cacheKey("treasury", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        bankBalance: m.bankBalance || 0,
        bankAccountCount: m.bankAccountCount || 0,
        fxExposureLevel: m.fxExposureLevel || "Low",
        fxExposureTotal: m.fxExposureTotal || 0,
        fxBaseCurrency: m.fxBaseCurrency || null,
        netCashFlowToday: m.netCashFlowToday || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async accountsReceivableDashboard({ tenantId }) {
    const key = cacheKey("ar", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        outstandingAR: m.outstandingAR || 0,
        outstandingReceivableCount: m.outstandingReceivableCount || 0,
        overdueReceivables: m.overdueReceivables || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async accountsPayableDashboard({ tenantId }) {
    const key = cacheKey("ap", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        outstandingAP: m.outstandingAP || 0,
        outstandingPayableCount: m.outstandingPayableCount || 0,
        overduePayables: m.overduePayables || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async revenueDashboard({ tenantId }) {
    const key = cacheKey("revenue", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        todaysRevenue: m.todaysRevenue || 0,
        grossProfit: summary.kpis?.grossProfit || 0,
        netProfit: summary.kpis?.netProfit || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async expenseDashboard({ tenantId }) {
    const key = cacheKey("expense", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        todaysExpenses: m.todaysExpenses || 0,
        expenseRatio: summary.kpis?.expenseRatio || 0,
        exceededBudgetCount: m.exceededBudgetCount || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async cashFlowDashboard({ tenantId }) {
    const key = cacheKey("cashflow", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const m = summary.metrics || {};
      return {
        cashToday: m.cashToday || 0,
        todaysRevenue: m.todaysRevenue || 0,
        todaysExpenses: m.todaysExpenses || 0,
        netCashFlowToday: m.netCashFlowToday || 0,
        workingCapital: summary.kpis?.workingCapital || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async taxDashboard({ tenantId }) {
    const key = cacheKey("tax", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const taxAlerts = (summary.alerts || []).filter((a) => a.alertType === "TaxDue");
      return {
        taxDueAlerts: taxAlerts,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  // Financial Analytics Platform Enhancements — Part 29. "CEO Dashboard,
  // Board Dashboard." Real aliases of the existing Executive Dashboard's
  // own data — this codebase has no distinct CEO-only or Board-only
  // metric anywhere; reusing the same real company-wide summary under
  // the spec's own audience labels rather than fabricating a separate
  // calculation with no independent real basis.
  static async ceoDashboard({ tenantId }) {
    return this.executiveDashboard({ tenantId });
  }

  static async boardDashboard({ tenantId }) {
    return this.executiveDashboard({ tenantId });
  }

  /**
   * "Department Analytics... Department Expenses." Real, current-month
   * ExpenseModel aggregation grouped by its own real `department` field
   * (a genuine ObjectId ref to DepartmentModel — Part 16's own expense
   * schema already carried this; it was simply never grouped by before).
   * Not part of FinanceOperationsSummaryModel's own tenant-wide daily
   * summary, so this queries directly (still real, still cached, never
   * fabricated) rather than reading a field that summary doesn't have.
   */
  static async departmentDashboard({ tenantId }) {
    const key = cacheKey("department", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const grouped = await ExpenseModel.aggregate([
        { $match: { tenantId, department: { $ne: null }, status: { $in: ["Approved", "Reimbursed", "Closed"] }, expenseDate: { $gte: monthStart, $lte: now } } },
        { $group: { _id: "$department", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } }
      ]);
      const departmentIds = grouped.map((g) => g._id).filter(Boolean);
      const departments = departmentIds.length > 0 ? await DepartmentModel.find({ _id: { $in: departmentIds } }).select("name").lean() : [];
      const nameById = new Map(departments.map((d) => [d._id.toString(), d.name]));
      const byDepartment = grouped.map((g) => ({ departmentId: g._id.toString(), departmentName: nameById.get(g._id.toString()) || "Unknown", totalExpense: roundCurrency(g.total), expenseCount: g.count }));
      return { period: "MonthToDate", byDepartment, totalExpense: roundCurrency(byDepartment.reduce((s, d) => s + d.totalExpense, 0)), generatedAt: new Date() };
    });
    return { fromCache, data };
  }

  /**
   * POST /api/v1/financial-dashboard/refresh — a genuinely missing manual
   * trigger this Part fills: `KPIEngine.refreshFinanceSummary` has always
   * run automatically on relevant domain events and on cache-miss
   * (Part 25), but there was no synchronous "refresh now and return the
   * fresh summary" endpoint until now.
   */
  static async refreshDashboard({ tenantId }) {
    const summary = await KPIEngine.refreshFinanceSummary({ tenantId });
    return { fromCache: false, data: { ...(summary?.metrics || {}), kpis: summary?.kpis || {}, generatedAt: summary?.generatedAt || new Date() } };
  }

  static async customDashboard({ tenantId, metricKeys = [] }) {
    const { summary } = await this.getSummary({ tenantId });
    const m = summary.metrics || {};
    const k = summary.kpis || {};
    const selected = metricKeys.length > 0
      ? Object.fromEntries(metricKeys.map((key) => [key, m[key] ?? k[key] ?? null]))
      : { ...m, ...k };
    return { fromCache: false, data: { ...selected, generatedAt: summary.generatedAt, pendingRefresh: summary.pendingRefresh || false } };
  }

  static async calculateKPIs({ tenantId }) {
    const key = cacheKey("kpis", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      return { ...(summary.kpis || {}), generatedAt: summary.generatedAt, pendingRefresh: summary.pendingRefresh || false };
    });
    return { fromCache, data };
  }

  // ── Alerts ──────────────────────────────────────────────────

  static async listAlerts({ tenantId, status = null }) {
    const filter = { tenantId };
    if (status) filter.status = status;
    return DashboardAlertModel.find(filter).sort({ triggeredAt: -1 }).limit(200).lean();
  }

  static async acknowledgeAlert({ tenantId, alertId, userId }) {
    const alert = await DashboardAlertModel.findOne({ _id: alertId, tenantId });
    if (!alert) throw new Error("Alert not found.");
    if (alert.status === "Active") {
      alert.status = "Acknowledged";
      alert.acknowledgedBy = userId || null;
      alert.acknowledgedAt = new Date();
      await alert.save();
      publishEvent("AlertAcknowledged", { tenantId, alertId: alert._id.toString(), performedBy: userId || null });
    }
    return alert.toJSON();
  }

  // ── Drill-Through — reuses Part 24's own real FK-backed drillDown.
  // "Widget -> Report -> Ledger -> Journal -> Transaction -> Source
  // Document": a dashboard widget's number always traces back to an
  // already-generated FinancialReportModel (report parameters name the
  // period/accounts it summarized); from there this is exactly Part 24's
  // own drillDown(reportId, {accountId}, tenantId) — not a second,
  // parallel drill-down implementation. ──

  static async drillThrough({ tenantId, reportId, accountId }) {
    return FinancialReportService.drillDown(reportId, { accountId }, tenantId);
  }

  // ── Personalization ────────────────────────────────────────

  static async getPreferences({ tenantId, userId, dashboardType }) {
    // Reporting Platform Part 4 fix — DashboardPreferenceModel.module is
    // now required; this engine only ever writes "Finance" rows.
    const preference = await DashboardPreferenceModel.findOne({ tenantId, userId, module: "Finance", dashboardType }).lean();
    return preference || { tenantId, userId, module: "Finance", dashboardType, layout: null, favoriteWidgets: [], filters: {}, theme: null, refreshInterval: null };
  }

  static async savePreferences({ tenantId, userId, dashboardType, layout, favoriteWidgets, filters, theme, refreshInterval }) {
    const config = getFinanceConfig();
    if (!config.financeDashboardTypes.includes(dashboardType)) throw new Error(`Invalid dashboardType "${dashboardType}".`);
    if (refreshInterval && !config.dashboardRefreshIntervals.includes(refreshInterval)) throw new Error(`Invalid refreshInterval "${refreshInterval}".`);

    const update = {};
    if (layout !== undefined) update.layout = layout;
    if (favoriteWidgets !== undefined) update.favoriteWidgets = favoriteWidgets;
    if (filters !== undefined) update.filters = filters;
    if (theme !== undefined) update.theme = theme;
    if (refreshInterval !== undefined) update.refreshInterval = refreshInterval;

    const preference = await DashboardPreferenceModel.findOneAndUpdate(
      { tenantId, userId, module: "Finance", dashboardType },
      { $set: update, $setOnInsert: { tenantId, userId, module: "Finance", dashboardType } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    publishEvent("DashboardCustomized", { tenantId, userId, dashboardType, performedBy: userId || null });
    return preference.toJSON();
  }

  // ── Trend snapshot (chart/trend-line widgets) ───────────────

  static async buildTrendSnapshot({ tenantId, period = "7 Days" }) {
    const days = PERIOD_DAYS[period] || 7;
    const now = new Date();
    const dateStrings = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      dateStrings.push(new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    }

    const summaries = await FinanceOperationsSummaryModel.find({ tenantId, summaryDate: { $in: dateStrings } }).lean();
    const summaryMap = Object.fromEntries(summaries.map((item) => [item.summaryDate, item]));

    const trends = dateStrings.map((date) => {
      const summary = summaryMap[date];
      const m = summary?.metrics || {};
      return {
        date,
        cashToday: m.cashToday || 0,
        todaysRevenue: m.todaysRevenue || 0,
        todaysExpenses: m.todaysExpenses || 0,
        outstandingAR: m.outstandingAR || 0,
        outstandingAP: m.outstandingAP || 0,
        dataAvailable: !!summary,
      };
    });

    return { period, dataPointsCount: trends.length, dataPointsWithData: trends.filter((t) => t.dataAvailable).length, trends };
  }

  static async generateTrends({ tenantId, period = "7 Days" }) {
    const key = cacheKey("trends", tenantId, period.replace(/\s+/g, "-").toLowerCase());
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => this.buildTrendSnapshot({ tenantId, period }));
    return { fromCache, data };
  }
}

export default FinanceAnalyticsEngine;
