import VisaAnalyticsSummaryModel from "../models/VisaAnalyticsSummaryModel.js";
import VisaCustomerAnalyticsSummaryModel from "../models/VisaCustomerAnalyticsSummaryModel.js";
import KPIEngine from "./KPIEngine.js";
import CacheManager from "../utils/cacheManager.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";

const todayStr = () => new Date().toISOString().slice(0, 10);
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const cacheKey = (type, tenantId, branchId, suffix = "") =>
  `visa-dashboard:${type}:${tenantId}:${branchId}${suffix ? `:${suffix}` : ""}`;

const PERIOD_DAYS = {
  Today: 1,
  Yesterday: 2,
  Daily: 1,
  Weekly: 7,
  "7 Days": 7,
  Monthly: 30,
  "30 Days": 30,
  Quarterly: 90,
  "90 Days": 90,
  Yearly: 365,
  "1 Year": 365,
};

// "Security... Sensitive KPI masking" — Branch Dashboard (unlike Executive/
// Finance) is available to non-management branch staff too, but revenue is
// still a management-tier figure and must not leak to them.
const SENSITIVE_METRIC_KEYS = ["revenue"];
const SENSITIVE_KPI_KEYS = ["revenue", "refundRatio"];

class VisaAnalyticsEngine {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    const refreshEvents = [
      "VisaCaseCreated",
      "VisaCaseUpdated",
      "WorkflowTransitionCompleted",
      "DocumentUploaded",
      "VerificationApproved",
      "VerificationRejected",
      "EmbassySubmissionCreated",
      "VisaDecisionReceived",
      "AppointmentScheduled",
      "AppointmentCompleted",
      "PassportReceived",
      "PassportCollected",
      "IncidentCreated",
      "IncidentResolved",
      "BookingUpdated",
      "PaymentReceived",
    ];

    refreshEvents.forEach((eventName) =>
      subscribeEvent(eventName, ({ tenantId, branchId = "main" } = {}) => {
        if (!tenantId) return;
        queueMicrotask(() =>
          Promise.all([
            KPIEngine.refreshVisaSummary({ tenantId, branchId }),
            KPIEngine.refreshVisaSummary({ tenantId, branchId: "all" }),
          ]).catch((error) => console.error("Visa analytics refresh failed:", error))
        );
      })
    );
  }

  static async ensureSummary({ tenantId, branchId = "main" }) {
    const date = todayStr();
    let summary = await VisaAnalyticsSummaryModel.findOne({ tenantId, branchId, summaryDate: date }).lean();
    if (!summary) {
      // Dashboard requests must never aggregate transactional tables. An event
      // or scheduled worker creates the missing read model asynchronously.
      queueMicrotask(() => KPIEngine.refreshVisaSummary({ tenantId, branchId })
        .catch((error) => console.error("Initial Visa analytics refresh failed:", error)));
    }
    return summary || {
      tenantId,
      branchId,
      summaryDate: date,
      metrics: {},
      kpis: {},
      embassyMetrics: [],
      officerMetrics: [],
      complianceMetrics: {},
      aiInsights: {},
      financeMetrics: {},
      generatedAt: null,
      pendingRefresh: true,
    };
  }

  static async getSummary({ tenantId, branchId = "main" }) {
    const key = cacheKey("summary", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => this.ensureSummary({ tenantId, branchId }));
    return { summary: data, fromCache };
  }

  static async executiveDashboard({ tenantId, branchId = "main" }) {
    const key = cacheKey("executive", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      const trends = await this.buildTrendSnapshot({ tenantId, branchId, period: "7 Days" });
      return {
        ...summary.metrics,
        topEmbassies: summary.embassyMetrics || [],
        criticalAlerts: summary.metrics?.criticalIncidents || 0,
        trendData: trends.trends,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async operationsDashboard({ tenantId, branchId = "main" }) {
    const key = cacheKey("operations", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      const m = summary.metrics || {};
      return {
        currentQueue: m.activeApplications || 0,
        pendingDocuments: m.pendingDocuments || 0,
        pendingVerification: m.pendingVerification || 0,
        pendingEmbassyDecisions: m.pendingEmbassyDecisions || 0,
        todaysWork: {
          applications: m.todaysApplications || 0,
          submissions: m.todaysSubmissions || 0,
          appointments: m.todaysAppointments || 0,
          passportCollections: m.todaysPassportCollections || 0,
        },
        pendingCourierDispatch: m.pendingCourierDispatch || 0,
        pendingFollowUps: m.pendingFollowUps || 0,
        openIncidents: m.openIncidents || 0,
        passportInventory: m.passportInventory || 0,
        appointments: {
          today: m.todaysAppointments || 0,
          pending: m.pendingAppointments || 0,
          pendingInterviews: m.pendingInterviews || 0,
          pendingMedicals: m.pendingMedicals || 0,
        },
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async officerDashboard({ tenantId, branchId = "main", userId = null }) {
    const key = cacheKey("officer", tenantId, branchId, userId || "self");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      const metrics =
        (summary.officerMetrics || []).find((item) => String(item._id || "") === String(userId || "")) ||
        { assignedCases: 0, completedCases: 0, pendingCases: 0, incidentCount: 0, avgResolutionTimeMs: 0 };

      return {
        officerId: userId,
        assignedCases: metrics.assignedCases || 0,
        completedCases: metrics.completedCases || 0,
        pendingCases: metrics.pendingCases || 0,
        todaysTasks: metrics.pendingReviews || 0,
        todaysAppointments: metrics.todaysAppointments || 0,
        pendingReviews: metrics.pendingReviews || 0,
        incidentCount: metrics.incidentCount || 0,
        productivityScore: metrics.assignedCases
          ? Number((((metrics.completedCases || 0) / metrics.assignedCases) * 100).toFixed(2))
          : 0,
        averageResolutionTimeDays: metrics.avgResolutionTimeMs
          ? Number((metrics.avgResolutionTimeMs / 86_400_000).toFixed(2))
          : 0,
        performanceMetrics: {
          assignedCases: metrics.assignedCases || 0,
          completedCases: metrics.completedCases || 0,
          pendingCases: metrics.pendingCases || 0,
          productivityScore: metrics.assignedCases
            ? Number((((metrics.completedCases || 0) / metrics.assignedCases) * 100).toFixed(2))
            : 0,
        },
        notifications: [],
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async embassyDashboard({ tenantId, branchId = "main", embassyId = null, embassyName = null }) {
    const key = cacheKey("embassy", tenantId, branchId, embassyId || embassyName || "all");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      let embassies = summary.embassyMetrics || [];
      if (embassyId) embassies = embassies.filter((item) => String(item.embassyId || "") === String(embassyId));
      if (embassyName) embassies = embassies.filter((item) => String(item._id || "") === String(embassyName));

      return {
        applicationsPerEmbassy: embassies,
        approvalRate: summary.kpis?.approvalRate || 0,
        rejectionRate: summary.kpis?.rejectionRate || 0,
        averageProcessingDays: summary.metrics?.averageProcessingTimeDays || 0,
        pendingCases: embassies.reduce((sum, item) => sum + (item.pending || 0), 0),
        returnedCases: embassies.reduce((sum, item) => sum + (item.returned || 0), 0),
        slaCompliance: summary.kpis?.embassySlaCompliancePct || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async branchDashboard({ tenantId, branchId = "main", isManagement = false }) {
    const key = cacheKey("branch", tenantId, branchId, isManagement ? "full" : "masked");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      const metrics = { ...(summary.metrics || {}) };
      const kpis = { ...(summary.kpis || {}) };
      if (!isManagement) {
        SENSITIVE_METRIC_KEYS.forEach((k) => delete metrics[k]);
        SENSITIVE_KPI_KEYS.forEach((k) => delete kpis[k]);
      }
      return {
        branchId,
        ...metrics,
        kpis,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async financeDashboard({ tenantId, branchId = "main" }) {
    const key = cacheKey("finance", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      const finance = summary.financeMetrics || {};
      return {
        revenue: summary.metrics?.revenue || finance.totalRevenue || 0,
        totalBilled: finance.totalBilled || 0,
        refundedAmount: finance.refundedAmount || 0,
        refundRatio: summary.kpis?.refundRatio || 0,
        paidBookings: finance.paidBookings || 0,
        totalBookings: finance.totalBookings || 0,
        caseFeesRevenue: finance.caseFeesRevenue || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async customerDashboard({ tenantId, branchId = "main", customerId = null }) {
    const key = cacheKey("customer", tenantId, branchId, customerId || "all");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      if (customerId) {
        const customerSummary = await VisaCustomerAnalyticsSummaryModel.findOne({
          tenantId,
          branchId,
          customerId: String(customerId),
          summaryDate: todayStr(),
        }).lean();
        if (!customerSummary) {
          queueMicrotask(() => KPIEngine.refreshVisaSummary({ tenantId, branchId })
            .catch((error) => console.error("Customer analytics refresh failed:", error)));
        }
        const stats = customerSummary?.metrics || {};
        return {
          customerId,
          activeApplications: stats.activeApplications || 0,
          completedApplications: stats.completedApplications || 0,
          pendingDocuments: stats.pendingDocuments || 0,
          pendingAppointments: stats.pendingAppointments || 0,
          approvalRate: stats.approvalRate || 0,
          generatedAt: customerSummary?.generatedAt || null,
          pendingRefresh: !customerSummary,
        };
      }

      const { summary } = await this.getSummary({ tenantId, branchId });
      return {
        customerId: null,
        activeApplications: summary.metrics?.activeApplications || 0,
        completedApplications: summary.metrics?.completedApplications || 0,
        pendingDocuments: summary.metrics?.pendingDocuments || 0,
        pendingAppointments: summary.metrics?.pendingAppointments || 0,
        approvalRate: summary.metrics?.approvalRate || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async complianceDashboard({ tenantId, branchId = "main" }) {
    const key = cacheKey("compliance", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      return {
        ...(summary.complianceMetrics || {}),
        slaBreaches: summary.metrics?.slaBreaches || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async aiInsightsDashboard({ tenantId, branchId = "main" }) {
    const key = cacheKey("ai-insights", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      return {
        ...(summary.aiInsights || {}),
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async calculateKPIs({ tenantId, branchId = "main" }) {
    const key = cacheKey("kpis", tenantId, branchId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId, branchId });
      return {
        ...(summary.kpis || {}),
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async buildTrendSnapshot({ tenantId, branchId = "main", period = "7 Days", dateFrom = null, dateTo = null }) {
    let dateStrings = [];
    let resolvedPeriod = period;

    // "Trend Analysis... Custom Date Range" — was entirely unimplemented;
    // period was always treated as a fixed day-count bucket with no way to
    // request an explicit start/end range.
    if (dateFrom && dateTo) {
      const start = new Date(dateFrom);
      const end = new Date(dateTo);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
        throw new Error("Invalid custom date range: dateFrom/dateTo must be valid dates with dateFrom <= dateTo.");
      }
      const maxRangeDays = parseInt(process.env.DASHBOARD_TREND_MAX_RANGE_DAYS || "366", 10);
      const rangeDays = Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
      if (rangeDays > maxRangeDays) {
        throw new Error(`Custom date range cannot exceed ${maxRangeDays} days.`);
      }
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dateStrings.push(d.toISOString().slice(0, 10));
      }
      resolvedPeriod = "Custom Date Range";
    } else {
      const days = PERIOD_DAYS[period] || 7;
      const now = new Date();
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        dateStrings.push(d.toISOString().slice(0, 10));
      }
    }

    const summaries = await VisaAnalyticsSummaryModel.find({
      tenantId,
      branchId,
      summaryDate: { $in: dateStrings },
    }).lean();

    const summaryMap = Object.fromEntries(summaries.map((item) => [item.summaryDate, item]));
    const trends = dateStrings.map((date) => {
      const summary = summaryMap[date];
      const metrics = summary?.metrics || {};
      return {
        date,
        totalApplications: metrics.totalApplications || 0,
        activeApplications: metrics.activeApplications || 0,
        completedApplications: metrics.completedApplications || 0,
        rejectedApplications: metrics.rejectedApplications || 0,
        approvalRate: metrics.approvalRate || 0,
        revenue: metrics.revenue || 0,
        openIncidents: metrics.openIncidents || 0,
        slaBreaches: metrics.slaBreaches || 0,
        dataAvailable: !!summary,
      };
    });

    return {
      period: resolvedPeriod,
      branchId,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      dataPointsCount: trends.length,
      dataPointsWithData: trends.filter((item) => item.dataAvailable).length,
      trends,
    };
  }

  static async generateTrends({ tenantId, branchId = "main", period = "7 Days", dateFrom = null, dateTo = null }) {
    const keySuffix = dateFrom && dateTo
      ? `custom-${dateFrom}-${dateTo}`
      : period.replace(/\s+/g, "-").toLowerCase();
    const key = cacheKey("trends", tenantId, branchId, keySuffix);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () =>
      this.buildTrendSnapshot({ tenantId, branchId, period, dateFrom, dateTo })
    );
    return { fromCache, data };
  }
}

export default VisaAnalyticsEngine;
