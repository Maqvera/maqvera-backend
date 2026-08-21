import VisaAnalyticsSummaryModel from "../models/VisaAnalyticsSummaryModel.js";
import VisaCustomerAnalyticsSummaryModel from "../models/VisaCustomerAnalyticsSummaryModel.js";
import KPIEngine from "./KPIEngine.js";
import CacheManager from "../utils/cacheManager.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";

const todayStr = () => new Date().toISOString().slice(0, 10);
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const cacheKey = (type, tenantId, suffix = "") =>
  `visa-dashboard:${type}:${tenantId}${suffix ? `:${suffix}` : ""}`;

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
      subscribeEvent(eventName, ({ tenantId } = {}) => {
        if (!tenantId) return;
        queueMicrotask(() =>
          KPIEngine.refreshVisaSummary({ tenantId })
            .catch((error) => console.error("Visa analytics refresh failed:", error))
        );
      })
    );
  }

  static async ensureSummary({ tenantId }) {
    const date = todayStr();
    let summary = await VisaAnalyticsSummaryModel.findOne({ tenantId, summaryDate: date }).lean();
    if (!summary) {
      // Dashboard requests must never aggregate transactional tables. An event
      // or scheduled worker creates the missing read model asynchronously.
      queueMicrotask(() => KPIEngine.refreshVisaSummary({ tenantId })
        .catch((error) => console.error("Initial Visa analytics refresh failed:", error)));
    }
    return summary || {
      tenantId,
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

  static async getSummary({ tenantId }) {
    const key = cacheKey("summary", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => this.ensureSummary({ tenantId }));
    return { summary: data, fromCache };
  }

  static async executiveDashboard({ tenantId }) {
    const key = cacheKey("executive", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const trends = await this.buildTrendSnapshot({ tenantId, period: "7 Days" });
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

  static async operationsDashboard({ tenantId }) {
    const key = cacheKey("operations", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
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

  static async officerDashboard({ tenantId, userId = null }) {
    const key = cacheKey("officer", tenantId, userId || "self");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
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

  static async embassyDashboard({ tenantId, embassyId = null, embassyName = null }) {
    const key = cacheKey("embassy", tenantId, embassyId || embassyName || "all");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
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

  static async financeDashboard({ tenantId }) {
    const key = cacheKey("finance", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      const finance = summary.financeMetrics || {};
      return {
        revenue: summary.metrics?.revenue || finance.totalRevenue || 0,
        totalBilled: finance.totalBilled || 0,
        refundedAmount: finance.refundedAmount || 0,
        refundRatio: summary.kpis?.refundRatio || 0,
        paidBookings: finance.paidBookings || 0,
        totalBookings: finance.totalBookings || 0,
        caseFeesRevenue: finance.caseFeesRevenue || 0,
        caseFeesVendorCost: finance.caseFeesVendorCost || 0,
        profit: finance.caseFeesProfit ?? ((finance.caseFeesRevenue || 0) - (finance.caseFeesVendorCost || 0)),
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async customerDashboard({ tenantId, customerId = null }) {
    const key = cacheKey("customer", tenantId, customerId || "all");
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      if (customerId) {
        const customerSummary = await VisaCustomerAnalyticsSummaryModel.findOne({
          tenantId,
          customerId: String(customerId),
          summaryDate: todayStr(),
        }).lean();
        if (!customerSummary) {
          queueMicrotask(() => KPIEngine.refreshVisaSummary({ tenantId })
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

      const { summary } = await this.getSummary({ tenantId });
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

  static async complianceDashboard({ tenantId }) {
    const key = cacheKey("compliance", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      return {
        ...(summary.complianceMetrics || {}),
        slaBreaches: summary.metrics?.slaBreaches || 0,
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async aiInsightsDashboard({ tenantId }) {
    const key = cacheKey("ai-insights", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      return {
        ...(summary.aiInsights || {}),
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async calculateKPIs({ tenantId }) {
    const key = cacheKey("kpis", tenantId);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () => {
      const { summary } = await this.getSummary({ tenantId });
      return {
        ...(summary.kpis || {}),
        generatedAt: summary.generatedAt,
        pendingRefresh: summary.pendingRefresh || false,
      };
    });
    return { fromCache, data };
  }

  static async buildTrendSnapshot({ tenantId, period = "7 Days", dateFrom = null, dateTo = null }) {
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
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      dataPointsCount: trends.length,
      dataPointsWithData: trends.filter((item) => item.dataAvailable).length,
      trends,
    };
  }

  static async generateTrends({ tenantId, period = "7 Days", dateFrom = null, dateTo = null }) {
    const keySuffix = dateFrom && dateTo
      ? `custom-${dateFrom}-${dateTo}`
      : period.replace(/\s+/g, "-").toLowerCase();
    const key = cacheKey("trends", tenantId, keySuffix);
    const { data, fromCache } = await CacheManager.getOrCompute(key, async () =>
      this.buildTrendSnapshot({ tenantId, period, dateFrom, dateTo })
    );
    return { fromCache, data };
  }
}

export default VisaAnalyticsEngine;
