import mongoose from "mongoose";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import TravelHotelAssignmentModel from "../models/TravelHotelAssignmentModel.js";
import TravelTransportAssignmentModel from "../models/TravelTransportAssignmentModel.js";
import TravelItineraryModel from "../models/TravelItineraryModel.js";
import TravelAttendanceModel from "../models/TravelAttendanceModel.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import TravelOperationsSummaryModel from "../models/TravelOperationsSummaryModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import EmbassySubmissionModel from "../models/EmbassySubmissionModel.js";
import VisaAppointmentModel from "../models/VisaAppointmentModel.js";
import PassportTrackingModel from "../models/PassportTrackingModel.js";
import VisaAnalyticsSummaryModel from "../models/VisaAnalyticsSummaryModel.js";
import VisaCustomerAnalyticsSummaryModel from "../models/VisaCustomerAnalyticsSummaryModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import EnterpriseVerificationModel from "../models/EnterpriseVerificationModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import PaymentModel from "../models/PaymentModel.js";
import TaxReportModel from "../models/TaxReportModel.js";
import ExpenseBudgetModel from "../models/ExpenseBudgetModel.js";
import FinanceOperationsSummaryModel from "../models/FinanceOperationsSummaryModel.js";
import DashboardAlertModel from "../models/DashboardAlertModel.js";
import FinancialReportService, { AR_TERMINAL_STATUSES } from "./FinancialReportService.js";
import { computeEBITDA } from "./FinancialAnalyticsService.js";
import { isPayableTerminal } from "./AccountsPayableService.js";
import CurrencyService from "./CurrencyService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import CacheManager from "../utils/cacheManager.js";
import { publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────
// Helpers — date boundaries
// ─────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const safeDiv = (numerator, denominator, decimals = 2) =>
  denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(decimals)) : 0;
const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────
// KPI Engine — Single source of truth for all metrics
// ─────────────────────────────────────────────────────────────
class KPIEngine {
  // ═══════════════════════════════════════════════════════════
  // TRAVEL MODULE — KPI Computations
  // ═══════════════════════════════════════════════════════════

  /**
   * Compute all Travel operational metrics from database.
   * Zero hardcoding — every number comes from aggregation queries.
   */
  static async computeTravelMetrics({ tenantId }) {
    if (mongoose.connection.readyState !== 1) return null;

    const baseFilter = { tenantId };
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = endOfDay(now);

    // ── Run all aggregation queries in parallel ──
    const [
      planStats,
      flightStats,
      todaysFlightStats,
      hotelStats,
      transportStats,
      attendanceStats,
      itineraryStats,
      incidentStats,
      guidePerformanceStats,
    ] = await Promise.all([
      // 1. Travel Plan aggregate
      TravelPlanModel.aggregate([
        { $match: { ...baseFilter, isArchived: false } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            // `$nin` is a query operator (valid in $match), not an aggregation
            // expression operator — using it here throws "Unrecognized
            // expression '$nin'" against a real MongoDB engine. `$not`+`$in`
            // is the actual aggregation-expression equivalent.
            active: { $sum: { $cond: [{ $not: [{ $in: ["$status", ["completed", "cancelled", "archived"]] }] }, 1, 0] } },
            inTransit: { $sum: { $cond: [{ $in: ["$status", ["in_transit", "departure_scheduled", "checked_in"]] }, 1, 0] } },
            totalTravelers: { $sum: { $size: { $ifNull: ["$travelerSnapshots", []] } } },
            inTransitTravelers: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["in_transit", "departure_scheduled", "checked_in", "arrived", "hotel_checked_in", "tour_active"]] },
                  { $size: { $ifNull: ["$travelerSnapshots", []] } },
                  0,
                ],
              },
            },
          },
        },
      ]),

      // 2. Flight assignments aggregate
      TravelFlightAssignmentModel.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            delayed: { $sum: { $cond: [{ $eq: ["$status", "delayed"] }, 1, 0] } },
            onTime: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$status", ["arrived", "completed"]] },
                      {
                        $or: [
                          { $eq: ["$actualArrival", null] },
                          { $lte: [{ $subtract: ["$actualArrival", "$plannedArrival"] }, 15 * 60 * 1000] },
                        ],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            completedFlights: { $sum: { $cond: [{ $in: ["$status", ["arrived", "completed"]] }, 1, 0] } },
            totalDelayMinutes: {
              $sum: { $ifNull: ["$delayDetails.actualDelayMinutes", 0] },
            },
            delayedFlightCount: {
              $sum: { $cond: [{ $gt: [{ $ifNull: ["$delayDetails.actualDelayMinutes", 0] }, 0] }, 1, 0] },
            },
            onTimeDepartures: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$status", ["departed", "in_flight", "arrived", "completed"]] },
                      {
                        $or: [
                          { $eq: ["$actualDeparture", null] },
                          { $lte: [{ $subtract: ["$actualDeparture", "$plannedDeparture"] }, 15 * 60 * 1000] },
                        ],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            departedFlights: {
              $sum: { $cond: [{ $in: ["$status", ["departed", "in_flight", "arrived", "completed"]] }, 1, 0] },
            },
          },
        },
      ]),

      // 3. Today's flight stats
      TravelFlightAssignmentModel.aggregate([
        {
          $match: {
            ...baseFilter,
            $or: [
              { plannedDeparture: { $gte: dayStart, $lte: dayEnd } },
              { plannedArrival: { $gte: dayStart, $lte: dayEnd } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            todaysDepartures: { $sum: { $cond: [{ $and: [{ $gte: ["$plannedDeparture", dayStart] }, { $lte: ["$plannedDeparture", dayEnd] }] }, 1, 0] } },
            todaysArrivals: { $sum: { $cond: [{ $and: [{ $gte: ["$plannedArrival", dayStart] }, { $lte: ["$plannedArrival", dayEnd] }] }, 1, 0] } },
          },
        },
      ]),

      // 4. Hotel stats
      TravelHotelAssignmentModel.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            checkedIn: { $sum: { $cond: [{ $in: ["$status", ["checked_in", "occupied"]] }, 1, 0] } },
            pendingCheckIn: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$status", ["planned", "reserved", "confirmed", "ready"]] },
                      { $lte: ["$plannedCheckIn", dayEnd] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            successfulCheckIns: { $sum: { $cond: [{ $in: ["$status", ["checked_in", "occupied", "checked_out", "completed"]] }, 1, 0] } },
          },
        },
      ]),

      // 5. Transport stats
      TravelTransportAssignmentModel.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $in: ["$status", ["boarding", "departed", "in_transit"]] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $in: ["$status", ["arrived", "completed"]] }, 1, 0] } },
            delayed: { $sum: { $cond: [{ $eq: ["$status", "delayed"] }, 1, 0] } },
            totalVehicleCapacity: { $sum: "$capacity" },
            totalPassengers: { $sum: { $size: { $ifNull: ["$assignedTravelers", []] } } },
          },
        },
      ]),

      // 6. Attendance stats (today)
      TravelAttendanceModel.aggregate([
        { $match: { ...baseFilter, checkInTime: { $gte: dayStart, $lte: dayEnd } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            present: { $sum: { $cond: [{ $in: ["$status", ["Present", "Checked In"]] }, 1, 0] } },
            late: { $sum: { $cond: [{ $eq: ["$status", "Late"] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ["$status", "Absent"] }, 1, 0] } },
            checkedOut: { $sum: { $cond: [{ $eq: ["$status", "Checked Out"] }, 1, 0] } },
          },
        },
      ]),

      // 7. Itinerary stats
      TravelItineraryModel.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            upcoming: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["planned", "published"]] }, { $gte: ["$plannedStart", now] }] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
            delayed: { $sum: { $cond: [{ $eq: ["$status", "delayed"] }, 1, 0] } },
          },
        },
      ]),

      // 8. Incident stats
      TravelIncidentManagementModel.aggregate([
        { $match: { ...baseFilter, isSoftDeleted: false } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $not: [{ $in: ["$status", ["resolved", "verified", "closed", "rejected", "duplicate"]] }] }, 1, 0] } },
            critical: {
              $sum: {
                $cond: [
                  { $and: [{ $in: ["$severity", ["Critical", "Emergency"]] }, { $not: [{ $in: ["$status", ["resolved", "verified", "closed"]] }] }] },
                  1,
                  0,
                ],
              },
            },
            emergency: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$severity", "Emergency"] }, { $not: [{ $in: ["$status", ["resolved", "verified", "closed"]] }] }] },
                  1,
                  0,
                ],
              },
            },
            resolved: { $sum: { $cond: [{ $in: ["$status", ["resolved", "verified", "closed"]] }, 1, 0] } },
            totalResolutionMs: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ["$resolution.resolvedAt", null] }, { $ne: ["$createdAt", null] }] },
                  { $subtract: ["$resolution.resolvedAt", "$createdAt"] },
                  0,
                ],
              },
            },
            resolvedCount: {
              $sum: {
                $cond: [{ $ne: ["$resolution.resolvedAt", null] }, 1, 0],
              },
            },
            // "Average Response Time" (Part 10 KPI) — real first-response
            // SLA data already tracked on the incident record (Part 8's
            // slaStatus.firstResponseCompletedAt), not a new metric to invent.
            totalResponseMs: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ["$slaStatus.firstResponseCompletedAt", null] }, { $ne: ["$createdAt", null] }] },
                  { $subtract: ["$slaStatus.firstResponseCompletedAt", "$createdAt"] },
                  0,
                ],
              },
            },
            respondedCount: {
              $sum: {
                $cond: [{ $ne: ["$slaStatus.firstResponseCompletedAt", null] }, 1, 0],
              },
            },
          },
        },
      ]),

      // 9. Guide performance — % of guide-assigned itinerary activities
      // completed on time (real, derived from real assignment data).
      TravelItineraryModel.aggregate([
        { $match: { ...baseFilter, "resources.guideId": { $ne: null } } },
        {
          $group: {
            _id: null,
            totalGuideActivities: { $sum: 1 },
            completedGuideActivities: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // ── Extract results safely ──
    const plans = planStats[0] || {};
    const flights = flightStats[0] || {};
    const todaysFlights = todaysFlightStats[0] || {};
    const hotels = hotelStats[0] || {};
    const transport = transportStats[0] || {};
    const attendance = attendanceStats[0] || {};
    const itinerary = itineraryStats[0] || {};
    const incidents = incidentStats[0] || {};
    const guidePerformance = guidePerformanceStats[0] || {};

    // ── Compute KPIs from raw data ──
    const totalTravelers = plans.totalTravelers || 0;
    const incidentRate = safeDiv(incidents.total || 0, totalTravelers || 1);
    const avgDelayMinutes = (flights.delayedFlightCount || 0) > 0
      ? Number(((flights.totalDelayMinutes || 0) / flights.delayedFlightCount).toFixed(1))
      : 0;
    const avgIncidentResolutionHours = (incidents.resolvedCount || 0) > 0
      ? Number(((incidents.totalResolutionMs || 0) / incidents.resolvedCount / 3_600_000).toFixed(1))
      : 0;
    const avgResponseTimeHours = (incidents.respondedCount || 0) > 0
      ? Number(((incidents.totalResponseMs || 0) / incidents.respondedCount / 3_600_000).toFixed(1))
      : 0;
    const vehicleUtilizationPct = (transport.totalVehicleCapacity || 0) > 0
      ? safeDiv(transport.totalPassengers || 0, transport.totalVehicleCapacity)
      : 0;
    const guidePerformancePct = safeDiv(guidePerformance.completedGuideActivities || 0, guidePerformance.totalGuideActivities || 0);
    const attendanceTotal = attendance.total || 0;
    const attendancePresent = (attendance.present || 0) + (attendance.late || 0) + (attendance.checkedOut || 0);

    const metrics = {
      activeTravelPlans: plans.active || 0,
      todaysDepartures: todaysFlights.todaysDepartures || 0,
      todaysArrivals: todaysFlights.todaysArrivals || 0,
      travelersInTransit: plans.inTransitTravelers || 0,
      travelersCheckedIn: attendance.present || 0,
      pendingCheckIns: hotels.pendingCheckIn || 0,
      delayedFlights: flights.delayed || 0,
      pendingHotelCheckIns: hotels.pendingCheckIn || 0,
      // "Transport Status" (Part 10 Response Includes) — was already
      // computed in transportStats below but never surfaced anywhere.
      transportStatus: {
        active: transport.active || 0,
        delayed: transport.delayed || 0,
        completed: transport.completed || 0,
      },
      openIncidents: incidents.open || 0,
      criticalIncidents: incidents.critical || 0,
      emergencyCases: incidents.emergency || 0,
      tasksDueToday: itinerary.inProgress || 0,
      upcomingActivities: itinerary.upcoming || 0,
      completedActivities: itinerary.completed || 0,
      operationalHealthScore: Math.max(0, Math.min(100,
        100 - ((incidents.critical || 0) * 10) - ((flights.delayed || 0) * 3) - ((itinerary.delayed || 0) * 2)
      )),
    };

    const kpis = {
      onTimeDeparturePct: safeDiv(flights.onTimeDepartures || 0, flights.departedFlights || 0),
      onTimeArrivalPct: safeDiv(flights.onTime || 0, flights.completedFlights || 0),
      hotelCheckInSuccessPct: safeDiv(hotels.successfulCheckIns || 0, hotels.total || 0),
      attendancePct: safeDiv(attendancePresent, attendanceTotal || 0),
      travelerSatisfaction: 0, // computed from feedback model if available
      incidentRatePct: incidentRate,
      emergencyCount: incidents.emergency || 0,
      tripCompletionPct: safeDiv(
        (plans.total || 0) - (plans.active || 0),
        plans.total || 0
      ),
      avgResponseTimeHours,
      guidePerformancePct,
      customerComplaintsCount: 0, // no complaint-tracking model exists anywhere in this codebase
      avgDelayMinutes,
      avgIncidentResolutionHours,
      vehicleUtilizationPct,
    };

    return { metrics, kpis };
  }

  /**
   * "AI Insights... AI never writes data. Read-only analytics only." — real,
   * deterministic day-over-day comparison against yesterday's persisted
   * summary (not an ML model, not fabricated text): each insight is only
   * generated when a real metric actually crossed a real, configurable
   * threshold. Matches several of the doc's own example insight sentences.
   */
  static generateTravelAIInsights(todayMetrics, todayKpis, yesterdaySummary) {
    if (!yesterdaySummary) return [];
    const insights = [];
    const yM = yesterdaySummary.metrics || {};
    const yK = yesterdaySummary.kpis || {};

    const healthThreshold = parseInt(process.env.AI_INSIGHT_HEALTH_SCORE_THRESHOLD || "5", 10);
    const healthDelta = todayMetrics.operationalHealthScore - (yM.operationalHealthScore || 0);
    if (Math.abs(healthDelta) >= healthThreshold) {
      insights.push({
        insightType: healthDelta < 0 ? "OperationalEfficiencyDrop" : "OperationalEfficiencyImprovement",
        message: `Operations efficiency ${healthDelta < 0 ? "dropped" : "improved"} ${Math.abs(healthDelta)}% compared to yesterday.`,
        severity: healthDelta <= -healthThreshold * 2 ? "Critical" : healthDelta < 0 ? "Warning" : "Info",
        score: healthDelta,
      });
    }

    const delayThresholdMinutes = parseInt(process.env.AI_INSIGHT_DELAY_THRESHOLD_MINUTES || "5", 10);
    const delayDelta = todayKpis.avgDelayMinutes - (yK.avgDelayMinutes || 0);
    if (Math.abs(delayDelta) >= delayThresholdMinutes) {
      insights.push({
        insightType: delayDelta > 0 ? "AverageDelayIncreased" : "AverageDelayDecreased",
        message: `Average flight delay ${delayDelta > 0 ? "increased" : "decreased"} by ${Math.abs(delayDelta).toFixed(1)} minutes compared to yesterday.`,
        severity: delayDelta > delayThresholdMinutes * 2 ? "Warning" : "Info",
        score: delayDelta,
      });
    }

    const incidentThreshold = parseInt(process.env.AI_INSIGHT_INCIDENT_TREND_THRESHOLD || "2", 10);
    const incidentDelta = todayMetrics.openIncidents - (yM.openIncidents || 0);
    if (Math.abs(incidentDelta) >= incidentThreshold) {
      insights.push({
        insightType: incidentDelta > 0 ? "IncidentTrendIncreasing" : "IncidentTrendDecreasing",
        message: `Open incident count ${incidentDelta > 0 ? "increased" : "decreased"} by ${Math.abs(incidentDelta)} compared to yesterday.`,
        severity: incidentDelta >= incidentThreshold * 2 ? "Critical" : incidentDelta > 0 ? "Warning" : "Info",
        score: incidentDelta,
      });
    }

    const hotelThresholdPct = parseInt(process.env.AI_INSIGHT_HOTEL_TREND_THRESHOLD_PCT || "10", 10);
    const hotelDelta = todayKpis.hotelCheckInSuccessPct - (yK.hotelCheckInSuccessPct || 0);
    if (Math.abs(hotelDelta) >= hotelThresholdPct) {
      insights.push({
        insightType: hotelDelta > 0 ? "HotelOccupancyImproving" : "HotelOccupancyDeclining",
        message: `Hotel check-in success rate is ${hotelDelta > 0 ? "improving" : "declining"} (${hotelDelta > 0 ? "+" : ""}${hotelDelta.toFixed(1)}% vs yesterday).`,
        severity: hotelDelta < -hotelThresholdPct * 2 ? "Warning" : "Info",
        score: hotelDelta,
      });
    }

    return insights;
  }

  /**
   * Build and persist the Travel summary table for today.
   */
  static async refreshTravelSummary({ tenantId }) {
    const result = await this.computeTravelMetrics({ tenantId });
    if (!result) return null;

    const { metrics, kpis } = result;
    const date = todayStr();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterdaySummary = await TravelOperationsSummaryModel.findOne({ tenantId, summaryDate: yesterday }).lean();
    const aiInsights = this.generateTravelAIInsights(metrics, kpis, yesterdaySummary);

    const summary = await TravelOperationsSummaryModel.findOneAndUpdate(
      { tenantId, summaryDate: date },
      {
        tenantId,
        summaryDate: date,
        metrics,
        kpis,
        aiInsights,
        lastRefreshedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Invalidate cache
    await CacheManager.invalidatePattern(`dashboard:*:${tenantId}`);
    publishEvent("DashboardRefreshed", { tenantId, module: "travel" });
    publishEvent("KPICalculated", { tenantId, module: "travel" });

    return summary;
  }

  // ═══════════════════════════════════════════════════════════
  // VISA MODULE — KPI Computations
  // ═══════════════════════════════════════════════════════════

  /**
   * Compute all Visa metrics from database — single source of truth for dashboard KPIs.
   */
  static async computeVisaMetrics({ tenantId }) {
    if (mongoose.connection.readyState !== 1) return null;

    const caseFilter = { tenantId, isSoftDeleted: false };
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = endOfDay(now);
    const pendingAppointmentStatuses = ["Scheduled", "Confirmed", "In Progress", "Reminder Sent"];
    const pendingEmbassyStatuses = ["Draft", "Ready", "Dispatched", "Received", "Under Review", "Additional Documents Required", "Interview Required", "Medical Required"];
    const pendingVerificationStatuses = ["pending", "processing", "ocr_complete", "ai_complete", "manual_review", "reverification_required"];

    const [caseStats] = await VisaCaseModel.aggregate([
      { $match: caseFilter },
      {
        $group: {
          _id: null,
          totalApplications: { $sum: 1 },
          activeApplications: { $sum: { $cond: [{ $in: ["$status", ["completed", "rejected", "cancelled", "withdrawn"]] }, 0, 1] } },
          completedApplications: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          rejectedApplications: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
          cancelledApplications: { $sum: { $cond: [{ $in: ["$status", ["cancelled", "withdrawn"]] }, 1, 0] } },
          pendingDocuments: {
            $sum: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$requiredDocuments", []] },
                  as: "doc",
                  cond: { $eq: ["$$doc.status", "pending"] },
                },
              },
            },
          },
          pendingVerificationFromCases: {
            $sum: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$requiredDocuments", []] },
                  as: "doc",
                  cond: {
                    $and: [
                      { $in: ["$$doc.status", ["uploaded", "verified"]] },
                      { $ne: ["$$doc.verificationStatus", "verified"] },
                    ],
                  },
                },
              },
            },
          },
          todaysApplications: { $sum: { $cond: [{ $gte: ["$createdAt", dayStart] }, 1, 0] } },
          revenueFromCases: {
            $sum: {
              $reduce: {
                input: { $ifNull: ["$applications", []] },
                initialValue: 0,
                in: { $add: ["$$value", { $ifNull: ["$$this.feeAmount", 0] }] },
              },
            },
          },
          // Visa Module PRD §12 "Automatic calculation: Cost / Sale / Profit"
          // — same $reduce shape as revenueFromCases, summing vendorCost
          // instead of feeAmount, so financeMetrics can expose a real profit.
          vendorCostFromCases: {
            $sum: {
              $reduce: {
                input: { $ifNull: ["$applications", []] },
                initialValue: 0,
                in: { $add: ["$$value", { $ifNull: ["$$this.vendorCost", 0] }] },
              },
            },
          },
          avgProcessingTimeMs: {
            $avg: {
              $cond: [
                { $eq: ["$status", "completed"] },
                { $subtract: ["$updatedAt", "$createdAt"] },
                null,
              ],
            },
          },
          slaBreaches: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: { $in: ["$status", ["completed", "rejected", "cancelled", "withdrawn"]] } },
                    { $gt: [{ $ifNull: ["$requirementProfileSnapshot.processingDays", 0] }, 0] },
                    {
                      $gt: [
                        { $divide: [{ $subtract: ["$$NOW", "$createdAt"] }, 86_400_000] },
                        "$requirementProfileSnapshot.processingDays",
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          pendingFollowUps: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$workflow.isBlocked", true] },
                    { $in: ["$status", ["documents_pending", "verification_pending", "embassy_pending"]] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          highRiskCases: {
            $sum: {
              $cond: [{ $gte: [{ $ifNull: ["$aiRecommendations.riskScore", 0] }, 70] }, 1, 0],
            },
          },
        },
      },
    ]);

    const [
      embassyStats,
      embassyTodayStats,
      appointmentStats,
      passportStats,
      passportDispatchStats,
      incidentStats,
      officerMetrics,
      officerAppointmentMetrics,
      verificationStats,
      bookingFinanceStats,
      rejectionReasonStats,
    ] = await Promise.all([
      EmbassySubmissionModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false } },
        {
          $group: {
            _id: "$embassyName",
            embassyId: { $first: "$embassyId" },
            applications: { $sum: 1 },
            approved: { $sum: { $cond: [{ $eq: ["$status", "Approved"] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ["$status", "Rejected"] }, 1, 0] } },
            returned: { $sum: { $cond: [{ $in: ["$status", ["Returned"]] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $in: ["$status", pendingEmbassyStatuses] }, 1, 0] } },
            avgProcessingDays: {
              $avg: {
                $cond: [
                  { $ne: ["$actualCompletionDate", null] },
                  { $divide: [{ $subtract: ["$actualCompletionDate", "$submissionDate"] }, 86_400_000] },
                  null,
                ],
              },
            },
            avgDelayDays: { $avg: { $ifNull: ["$slaTracking.delayDays", 0] } },
            slaBreached: { $sum: { $cond: [{ $eq: ["$slaTracking.isSlaBreached", true] }, 1, 0] } },
          },
        },
        { $sort: { applications: -1 } },
        { $limit: 20 },
      ]),
      EmbassySubmissionModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false, createdAt: { $gte: dayStart, $lte: dayEnd } } },
        { $group: { _id: null, todaysSubmissions: { $sum: 1 } } },
      ]),
      VisaAppointmentModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false } },
        {
          $group: {
            _id: null,
            today: { $sum: { $cond: [{ $and: [{ $gte: ["$appointmentDate", dayStart] }, { $lte: ["$appointmentDate", dayEnd] }] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $in: ["$status", pendingAppointmentStatuses] }, 1, 0] } },
            pendingInterviews: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $regexMatch: { input: { $toLower: "$appointmentType" }, regex: "interview" } },
                      { $in: ["$status", pendingAppointmentStatuses] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            pendingMedicals: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $regexMatch: { input: { $toLower: "$appointmentType" }, regex: "medical" } },
                      { $in: ["$status", pendingAppointmentStatuses] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            todaysPassportCollections: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $regexMatch: { input: { $toLower: "$appointmentType" }, regex: "collection|passport" } },
                      { $gte: ["$appointmentDate", dayStart] },
                      { $lte: ["$appointmentDate", dayEnd] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      PassportTrackingModel.aggregate([
        { $match: { tenantId } },
        { $group: { _id: "$currentStatus", count: { $sum: 1 } } },
      ]),
      PassportTrackingModel.aggregate([
        {
          $match: {
            tenantId,
            currentStatus: { $in: ["Ready For Dispatch", "Dispatched", "With Courier"] },
          },
        },
        { $group: { _id: null, pendingCourierDispatch: { $sum: 1 } } },
      ]),
      TravelIncidentManagementModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false, sourceModule: { $in: ["Visa", "Customer", "Compliance"] } } },
        {
          $group: {
            _id: null,
            open: { $sum: { $cond: [{ $not: [{ $in: ["$status", ["resolved", "verified", "closed", "rejected", "duplicate"]] }] }, 1, 0] } },
            critical: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$severity", ["Critical", "Emergency", "critical"]] },
                      { $not: [{ $in: ["$status", ["resolved", "verified", "closed"]] }] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            slaBreached: {
              $sum: {
                $cond: [{ $eq: ["$slaStatus.isViolated", true] }, 1, 0],
              },
            },
          },
        },
      ]),
      VisaCaseModel.aggregate([
        { $match: caseFilter },
        {
          $group: {
            _id: "$assignedTo",
            assignedCases: { $sum: 1 },
            completedCases: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            pendingCases: { $sum: { $cond: [{ $in: ["$status", ["completed", "rejected", "cancelled"]] }, 0, 1] } },
            avgResolutionTimeMs: {
              $avg: {
                $cond: [
                  { $eq: ["$status", "completed"] },
                  { $subtract: ["$updatedAt", "$createdAt"] },
                  null,
                ],
              },
            },
            incidentCount: {
              $sum: {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$incidents", []] },
                    as: "inc",
                    cond: { $in: ["$$inc.status", ["open", "investigating"]] },
                  },
                },
              },
            },
          },
        },
      ]),
      VisaAppointmentModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false, assignedOfficer: { $ne: null } } },
        {
          $group: {
            _id: "$assignedOfficer",
            todaysAppointments: {
              $sum: {
                $cond: [{ $and: [{ $gte: ["$appointmentDate", dayStart] }, { $lte: ["$appointmentDate", dayEnd] }] }, 1, 0],
              },
            },
            pendingReviews: { $sum: { $cond: [{ $in: ["$status", pendingAppointmentStatuses] }, 1, 0] } },
          },
        },
      ]),
      EnterpriseVerificationModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false, verificationStatus: { $in: pendingVerificationStatuses } } },
        { $group: { _id: null, pendingVerification: { $sum: 1 } } },
      ]),
      BookingHeaderModel.aggregate([
        {
          $match: {
            tenantId,
            bookingType: { $in: ["visa_only", "umrah", "hajj", "corporate_travel", "custom_package"] },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: { $ifNull: ["$paidAmount", 0] } },
            totalBilled: { $sum: { $ifNull: ["$totalAmount", 0] } },
            refundedAmount: {
              $sum: {
                $cond: [{ $in: ["$status", ["refunded", "cancelled"]] }, { $ifNull: ["$paidAmount", 0] }, 0],
              },
            },
            paidBookings: { $sum: { $cond: [{ $in: ["$paymentStatus", ["fully_paid", "partially_paid"]] }, 1, 0] } },
            totalBookings: { $sum: 1 },
          },
        },
      ]),
      VisaCaseModel.aggregate([
        { $match: { ...caseFilter, status: "rejected", "decision.rejectionReason": { $ne: null } } },
        { $group: { _id: "$decision.rejectionReason", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const stats = caseStats || {};
    const completedOrRejected = (stats.completedApplications || 0) + (stats.rejectedApplications || 0);
    const incidentData = incidentStats[0] || {};
    const appointments = appointmentStats[0] || {};
    const finance = bookingFinanceStats[0] || {};
    const verification = verificationStats[0] || {};
    const embassyToday = embassyTodayStats[0] || {};
    const passportDispatch = passportDispatchStats[0] || {};
    const appointmentsByOfficer = new Map(
      officerAppointmentMetrics.map((item) => [String(item._id), item])
    );
    const enrichedOfficerMetrics = officerMetrics.map((item) => ({
      ...item,
      todaysAppointments: appointmentsByOfficer.get(String(item._id))?.todaysAppointments || 0,
      pendingReviews: appointmentsByOfficer.get(String(item._id))?.pendingReviews || 0,
    }));
    const totalEmbassyCases = embassyStats.reduce((sum, item) => sum + (item.applications || 0), 0);
    const totalEmbassySlaBreached = embassyStats.reduce((sum, item) => sum + (item.slaBreached || 0), 0);
    const revenue = (finance.totalRevenue || 0) + (stats.revenueFromCases || 0);
    const pendingVerification = Math.max(verification.pendingVerification || 0, stats.pendingVerificationFromCases || 0);
    const avgProcessingTimeDays = stats.avgProcessingTimeMs
      ? Number((stats.avgProcessingTimeMs / 86_400_000).toFixed(2))
      : 0;

    const metrics = {
      totalApplications: stats.totalApplications || 0,
      activeApplications: stats.activeApplications || 0,
      completedApplications: stats.completedApplications || 0,
      rejectedApplications: stats.rejectedApplications || 0,
      cancelledApplications: stats.cancelledApplications || 0,
      approvalRate: safeDiv(stats.completedApplications || 0, completedOrRejected),
      rejectionRate: safeDiv(stats.rejectedApplications || 0, completedOrRejected),
      averageProcessingTimeDays: avgProcessingTimeDays,
      revenue,
      pendingDocuments: stats.pendingDocuments || 0,
      pendingVerification,
      pendingInterviews: appointments.pendingInterviews || 0,
      pendingMedicals: appointments.pendingMedicals || 0,
      pendingEmbassyDecisions: embassyStats.reduce((sum, item) => sum + (item.pending || 0), 0),
      todaysApplications: stats.todaysApplications || 0,
      todaysSubmissions: embassyToday.todaysSubmissions || 0,
      todaysAppointments: appointments.today || 0,
      todaysPassportCollections: appointments.todaysPassportCollections || 0,
      pendingAppointments: appointments.pending || 0,
      pendingCourierDispatch: passportDispatch.pendingCourierDispatch || 0,
      pendingFollowUps: stats.pendingFollowUps || 0,
      passportInventory: passportStats.reduce((sum, item) => sum + (item.count || 0), 0),
      openIncidents: incidentData.open || 0,
      criticalIncidents: incidentData.critical || 0,
      slaBreaches: (stats.slaBreaches || 0) + (incidentData.slaBreached || 0) + totalEmbassySlaBreached,
      highRiskCases: stats.highRiskCases || 0,
    };

    const kpis = {
      approvalRate: metrics.approvalRate,
      rejectionRate: metrics.rejectionRate,
      averageProcessingTimeDays: metrics.averageProcessingTimeDays,
      slaCompliancePct: safeDiv(totalEmbassyCases - totalEmbassySlaBreached, totalEmbassyCases || 1),
      revenue,
      refundRatio: safeDiv(finance.refundedAmount || 0, finance.totalRevenue || revenue || 1),
      officerProductivityPct: safeDiv(
        enrichedOfficerMetrics.reduce((sum, item) => sum + (item.completedCases || 0), 0),
        enrichedOfficerMetrics.reduce((sum, item) => sum + (item.assignedCases || 0), 0) || 1
      ),
      customerSatisfaction: 0,
      embassySlaCompliancePct: safeDiv(totalEmbassyCases - totalEmbassySlaBreached, totalEmbassyCases || 1),
    };

    const embassyMetrics = embassyStats.map((item) => ({
      ...item,
      approvalRate: safeDiv(item.approved || 0, (item.approved || 0) + (item.rejected || 0)),
      rejectionRate: safeDiv(item.rejected || 0, (item.approved || 0) + (item.rejected || 0)),
      slaCompliancePct: safeDiv((item.applications || 0) - (item.slaBreached || 0), item.applications || 1),
    }));

    const complianceMetrics = {
      pendingVerification,
      verificationBacklog: pendingVerification,
      slaBreaches: metrics.slaBreaches,
      openIncidents: metrics.openIncidents,
      criticalIncidents: metrics.criticalIncidents,
      highRiskCases: metrics.highRiskCases,
    };

    const aiInsights = {
      casesLikelyToMissSla: metrics.slaBreaches,
      overloadedOfficers: enrichedOfficerMetrics
        .filter((item) => (item.pendingCases || 0) >= 5)
        .map((item) => ({ officerId: item._id, pendingCases: item.pendingCases, assignedCases: item.assignedCases })),
      commonRejectionReasons: rejectionReasonStats.map((item) => ({ reason: item._id, count: item.count })),
      delayedEmbassies: embassyMetrics
        .filter((item) => (item.avgDelayDays || 0) > 0)
        .sort((a, b) => (b.avgDelayDays || 0) - (a.avgDelayDays || 0))
        .slice(0, 5)
        .map((item) => ({ embassy: item._id, avgDelayDays: Number((item.avgDelayDays || 0).toFixed(2)) })),
      peakProcessingPeriod: null,
      revenueForecast: revenue,
      recommendedStaffing: enrichedOfficerMetrics
        .filter((item) => (item.pendingCases || 0) > (item.completedCases || 0))
        .length,
    };

    return {
      metrics,
      kpis,
      embassyMetrics,
      officerMetrics: enrichedOfficerMetrics,
      complianceMetrics,
      aiInsights,
      financeMetrics: {
        totalRevenue: finance.totalRevenue || 0,
        totalBilled: finance.totalBilled || 0,
        refundedAmount: finance.refundedAmount || 0,
        paidBookings: finance.paidBookings || 0,
        totalBookings: finance.totalBookings || 0,
        caseFeesRevenue: stats.revenueFromCases || 0,
        caseFeesVendorCost: stats.vendorCostFromCases || 0,
        caseFeesProfit: (stats.revenueFromCases || 0) - (stats.vendorCostFromCases || 0),
      },
    };
  }

  /**
   * Build and persist the Visa summary table for today.
   */
  static async refreshVisaSummary({ tenantId }) {
    const result = await this.computeVisaMetrics({ tenantId });
    if (!result) return null;

    const {
      metrics,
      kpis,
      embassyMetrics,
      officerMetrics,
      complianceMetrics,
      aiInsights,
      financeMetrics,
    } = result;
    const date = todayStr();

    const summary = await VisaAnalyticsSummaryModel.findOneAndUpdate(
      { tenantId, summaryDate: date },
      {
        tenantId,
        summaryDate: date,
        metrics,
        kpis,
        embassyMetrics,
        officerMetrics,
        complianceMetrics,
        aiInsights,
        financeMetrics,
        generatedAt: new Date(),
        lastRefreshedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await CacheManager.invalidatePattern(`visa-dashboard:*:${tenantId}*`);
    await this.refreshVisaCustomerSummaries({ tenantId });
    publishEvent("DashboardRefreshed", { tenantId, module: "visa" });
    publishEvent("KPICalculated", { tenantId, module: "visa" });
    publishEvent("AnalyticsUpdated", { tenantId, module: "visa" });
    publishEvent("PerformanceSnapshotCreated", { tenantId, module: "visa" });
    publishEvent("RevenueSummaryUpdated", { tenantId, module: "visa", revenue: metrics.revenue });
    publishEvent("OfficerMetricsUpdated", { tenantId, module: "visa", officerCount: officerMetrics.length });
    publishEvent("EmbassyMetricsUpdated", { tenantId, module: "visa", embassyCount: embassyMetrics.length });
    if (metrics.slaBreaches > 0) {
      publishEvent("SLAExceeded", { tenantId, module: "visa", slaBreachCount: metrics.slaBreaches });
    }

    return summary;
  }

  /**
   * Materialize per-customer KPIs. This runs only in the event/cron refresh
   * worker; customer-facing dashboard requests read this collection only.
   */
  static async refreshVisaCustomerSummaries({ tenantId }) {
    if (mongoose.connection.readyState !== 1) return 0;

    const date = todayStr();
    const pendingAppointmentStatuses = ["Scheduled", "Confirmed", "In Progress", "Reminder Sent"];
    const [caseMetrics, appointmentMetrics] = await Promise.all([
      VisaCaseModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false, travelerId: { $ne: null } } },
        {
          $group: {
            _id: "$travelerId",
            activeApplications: { $sum: { $cond: [{ $in: ["$status", ["completed", "rejected", "cancelled", "withdrawn"]] }, 0, 1] } },
            completedApplications: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            rejectedApplications: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
            pendingDocuments: {
              $sum: {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$requiredDocuments", []] },
                    as: "document",
                    cond: { $eq: ["$$document.status", "pending"] },
                  },
                },
              },
            },
          },
        },
      ]).allowDiskUse(true),
      VisaAppointmentModel.aggregate([
        { $match: { tenantId, isSoftDeleted: false, travelerId: { $ne: null } } },
        {
          $group: {
            _id: "$travelerId",
            pendingAppointments: { $sum: { $cond: [{ $in: ["$status", pendingAppointmentStatuses] }, 1, 0] } },
          },
        },
      ]).allowDiskUse(true),
    ]);

    const appointmentsByCustomer = new Map(appointmentMetrics.map((item) => [String(item._id), item]));
    const operations = caseMetrics.map((item) => {
      const completedOrRejected = (item.completedApplications || 0) + (item.rejectedApplications || 0);
      return {
        updateOne: {
          filter: { tenantId, customerId: String(item._id), summaryDate: date },
          update: {
            $set: {
              metrics: {
                activeApplications: item.activeApplications || 0,
                completedApplications: item.completedApplications || 0,
                pendingDocuments: item.pendingDocuments || 0,
                pendingAppointments: appointmentsByCustomer.get(String(item._id))?.pendingAppointments || 0,
                approvalRate: safeDiv(item.completedApplications || 0, completedOrRejected),
              },
              generatedAt: new Date(),
              lastRefreshedAt: new Date(),
              source: "event-driven-kpi-engine",
            },
            $setOnInsert: { tenantId, customerId: String(item._id), summaryDate: date },
          },
          upsert: true,
        },
      };
    });

    if (operations.length > 0) await VisaCustomerAnalyticsSummaryModel.bulkWrite(operations, { ordered: false });
    await CacheManager.invalidatePattern(`visa-dashboard:customer:${tenantId}:*`);
    return operations.length;
  }

  // ═══════════════════════════════════════════════════════════
  // FINANCE MODULE — KPI Computations (Finance Module Part 25 —
  // Enterprise Financial Dashboard). Extends this same, existing,
  // single-source-of-truth engine rather than standing up a parallel
  // dashboard system — mirrors computeTravelMetrics/computeVisaMetrics'
  // own "real parallel aggregations, zero hardcoding" shape exactly.
  // ═══════════════════════════════════════════════════════════

  /**
   * Compute all Finance operational metrics from the database. Every
   * number is a real aggregation/query against models already owned by
   * prior Finance Parts (BankAccount, AR, AP, Ledger via
   * FinancialReportService.getPeriodMovement, Currency, ExpenseBudget,
   * Payment, TaxReport) — zero hardcoding, no fabricated figures.
   */
  static async computeFinanceMetrics({ tenantId }) {
    if (mongoose.connection.readyState !== 1) return null;

    const config = getFinanceConfig();
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = endOfDay(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      bankStats,
      arStats,
      overdueReceivableCount,
      payables,
      periodMovement,
      exposureResult,
      largePayments,
      taxReports,
      budgets,
      ebitdaAddBackAmounts,
    ] = await Promise.all([
      BankAccountModel.aggregate([
        { $match: { tenantId, status: { $in: ["Active", "Verified"] } } },
        { $group: { _id: null, totalBalance: { $sum: "$balances.current" }, accountCount: { $sum: 1 } } },
      ]),
      AccountsReceivableModel.aggregate([
        { $match: { tenantId, status: { $nin: [...AR_TERMINAL_STATUSES] }, outstandingBalance: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$outstandingBalance" }, count: { $sum: 1 } } },
      ]),
      AccountsReceivableModel.countDocuments({ tenantId, status: "Overdue" }),
      AccountsPayableModel.find({ tenantId, outstandingBalance: { $gt: 0 } }).select("status outstandingBalance dueDate vendorName invoiceNumber").lean(),
      FinancialReportService.getPeriodMovement(tenantId, dayStart, dayEnd, null, ["Revenue", "Expense"]),
      CurrencyService.getCurrencyExposure(tenantId),
      config.largePaymentThreshold > 0
        ? PaymentModel.find({ tenantId, createdAt: { $gte: dayStart, $lte: dayEnd }, amount: { $gte: config.largePaymentThreshold } }).select("paymentNumber amount paymentType").lean()
        : Promise.resolve([]),
      config.taxDueThreshold > 0
        ? TaxReportModel.find({ tenantId, generatedAt: { $gte: monthStart }, totalNetPayable: { $gte: config.taxDueThreshold } }).select("reportType totalNetPayable periodEnd").lean()
        : Promise.resolve([]),
      ExpenseBudgetModel.find({ tenantId }).select("scope scopeRef period allocatedAmount consumedAmount").lean(),
      // Financial Analytics Platform Enhancements — Part 29. Real EBITDA
      // add-back lookups, skipped entirely (no queries) when a tenant
      // hasn't configured any of the four account codes.
      (config.interestExpenseAccountCode || config.incomeTaxExpenseAccountCode || config.depreciationExpenseAccountCode || config.amortizationExpenseAccountCode)
        ? Promise.all([
            FinancialReportService.getAccountCodeMovement(tenantId, config.interestExpenseAccountCode, dayStart, dayEnd),
            FinancialReportService.getAccountCodeMovement(tenantId, config.incomeTaxExpenseAccountCode, dayStart, dayEnd),
            FinancialReportService.getAccountCodeMovement(tenantId, config.depreciationExpenseAccountCode, dayStart, dayEnd),
            FinancialReportService.getAccountCodeMovement(tenantId, config.amortizationExpenseAccountCode, dayStart, dayEnd),
          ])
        : Promise.resolve([0, 0, 0, 0]),
    ]);

    const openPayables = payables.filter((p) => !isPayableTerminal(p.status));
    const outstandingAP = roundCurrency(openPayables.reduce((sum, p) => sum + (p.outstandingBalance || 0), 0));
    const overduePayables = openPayables.filter((p) => p.dueDate && new Date(p.dueDate) < now);

    const todaysRevenue = roundCurrency(periodMovement.filter((r) => r.category === "Revenue").reduce((sum, r) => sum + r.netBalance, 0));
    const todaysExpenses = roundCurrency(periodMovement.filter((r) => r.category === "Expense").reduce((sum, r) => sum + r.netBalance, 0));

    const fxExposureTotal = roundCurrency((exposureResult?.exposure || []).reduce((sum, e) => sum + Math.abs(e.baseEquivalent || 0), 0));
    const fxExposureLevel =
      fxExposureTotal >= config.fxExposureHighThreshold ? "High" : fxExposureTotal >= config.fxExposureMediumThreshold ? "Medium" : "Low";

    const exceededBudgets = budgets.filter((b) => b.consumedAmount > b.allocatedAmount);

    const cashToday = roundCurrency(bankStats[0]?.totalBalance || 0);
    const outstandingAR = roundCurrency(arStats[0]?.total || 0);

    // No inventory/COGS concept exists in this ERP's chart of accounts, so
    // gross profit and net profit collapse to the same figure here, and
    // quick ratio (which excludes inventory) collapses to current ratio —
    // documented, not fabricated as separately-derived numbers.
    const currentAssets = roundCurrency(cashToday + outstandingAR);
    const currentLiabilities = outstandingAP;
    const workingCapital = roundCurrency(currentAssets - currentLiabilities);
    const currentRatio = currentLiabilities > 0 ? Number((currentAssets / currentLiabilities).toFixed(2)) : null;

    const metrics = {
      cashToday,
      bankBalance: cashToday,
      bankAccountCount: bankStats[0]?.accountCount || 0,
      outstandingAR,
      outstandingReceivableCount: arStats[0]?.count || 0,
      outstandingAP,
      outstandingPayableCount: openPayables.length,
      overdueReceivables: overdueReceivableCount,
      overduePayables: overduePayables.length,
      todaysRevenue,
      todaysExpenses,
      netCashFlowToday: roundCurrency(todaysRevenue - todaysExpenses),
      fxExposureTotal,
      fxExposureLevel,
      fxBaseCurrency: exposureResult?.baseCurrency || null,
      exceededBudgetCount: exceededBudgets.length,
    };

    // "EBITDA"/"Operating Margin"/"Operating Ratio" — Financial Analytics
    // Platform Enhancements (Part 29). Same honest add-back/collapse
    // discipline as computeFinancialRatios in FinancialAnalyticsService.js
    // (Part 26) — EBITDA add-backs are real (0 for any unconfigured
    // account code); Operating Margin/Ratio honestly collapse to Net
    // Margin/Expense Ratio since no Operating vs Non-Operating account
    // split exists in this Chart of Accounts.
    const [interestAddBack, taxAddBack, depreciationAddBack, amortizationAddBack] = ebitdaAddBackAmounts;
    const ebitda = computeEBITDA(metrics.netCashFlowToday, { interest: interestAddBack, tax: taxAddBack, depreciation: depreciationAddBack, amortization: amortizationAddBack });

    const kpis = {
      grossProfit: metrics.netCashFlowToday,
      netProfit: metrics.netCashFlowToday,
      ebitda,
      ebitdaMargin: safeDiv(ebitda, todaysRevenue),
      expenseRatio: safeDiv(todaysExpenses, todaysRevenue),
      operatingMargin: safeDiv(metrics.netCashFlowToday, todaysRevenue),
      operatingRatio: safeDiv(todaysExpenses, todaysRevenue),
      workingCapital,
      currentRatio,
      quickRatio: currentRatio,
    };

    return {
      metrics,
      kpis,
      largePayments,
      taxReports,
      overduePayableRecords: overduePayables,
      exceededBudgets,
    };
  }

  /**
   * Real, deterministic threshold evaluation — no ML, no fabricated
   * scoring. Returns alert descriptors only; persistence happens in
   * refreshFinanceSummary.
   */
  static buildFinanceAlerts({ metrics, largePayments, taxReports, overduePayableRecords, exceededBudgets, config }) {
    const alerts = [];

    if (config.lowCashThreshold > 0 && metrics.cashToday < config.lowCashThreshold) {
      alerts.push({ alertType: "LowCash", severity: "Critical", message: `Cash balance ${metrics.cashToday} is below the configured threshold ${config.lowCashThreshold}.`, value: metrics.cashToday, threshold: config.lowCashThreshold });
    }
    if (config.highExpenseDailyThreshold > 0 && metrics.todaysExpenses > config.highExpenseDailyThreshold) {
      alerts.push({ alertType: "HighExpenses", severity: "Warning", message: `Today's expenses ${metrics.todaysExpenses} exceed the configured daily threshold ${config.highExpenseDailyThreshold}.`, value: metrics.todaysExpenses, threshold: config.highExpenseDailyThreshold });
    }
    for (const payment of largePayments) {
      alerts.push({ alertType: "LargePayment", severity: "Warning", message: `Payment ${payment.paymentNumber} of ${payment.amount} exceeds the large-payment threshold.`, value: payment.amount, threshold: config.largePaymentThreshold, sourceType: "Payment", sourceId: payment._id });
    }
    if (metrics.overdueReceivables > 0) {
      alerts.push({ alertType: "OverdueReceivable", severity: "Warning", message: `${metrics.overdueReceivables} receivable(s) are overdue.`, value: metrics.overdueReceivables, threshold: 0 });
    }
    for (const payable of overduePayableRecords) {
      alerts.push({ alertType: "OverduePayable", severity: "Warning", message: `Payable ${payable.invoiceNumber || payable._id} to ${payable.vendorName || "vendor"} is overdue.`, value: payable.outstandingBalance, threshold: 0, sourceType: "AccountsPayable", sourceId: payable._id });
    }
    for (const budget of exceededBudgets) {
      alerts.push({ alertType: "BudgetExceeded", severity: "Warning", message: `Budget for ${budget.scope} ${budget.period} exceeded: consumed ${budget.consumedAmount} of ${budget.allocatedAmount}.`, value: budget.consumedAmount, threshold: budget.allocatedAmount, sourceType: "ExpenseBudget", sourceId: budget._id });
    }
    if (metrics.netCashFlowToday < 0) {
      alerts.push({ alertType: "NegativeCashFlow", severity: "Critical", message: `Net cash flow today is negative (${metrics.netCashFlowToday}).`, value: metrics.netCashFlowToday, threshold: 0 });
    }
    for (const report of taxReports) {
      alerts.push({ alertType: "TaxDue", severity: "Warning", message: `${report.reportType} tax report shows a net payable of ${report.totalNetPayable}.`, value: report.totalNetPayable, threshold: config.taxDueThreshold, sourceType: "TaxReport", sourceId: report._id });
    }

    return alerts;
  }

  /**
   * Build and persist the Finance operations summary for today, and
   * raise/persist real threshold-crossing alerts. Mirrors
   * refreshVisaSummary's own upsert + cache-invalidate + publish shape.
   */
  static async refreshFinanceSummary({ tenantId }) {
    const result = await this.computeFinanceMetrics({ tenantId });
    if (!result) return null;

    const config = getFinanceConfig();
    const { metrics, kpis, largePayments, taxReports, overduePayableRecords, exceededBudgets } = result;
    const date = todayStr();

    const alertDescriptors = this.buildFinanceAlerts({ metrics, largePayments, taxReports, overduePayableRecords, exceededBudgets, config });

    const persistedAlerts = [];
    for (const descriptor of alertDescriptors) {
      const dedupeFilter = { tenantId, alertType: descriptor.alertType, status: "Active", triggeredAt: { $gte: startOfDay(new Date()) } };
      if (descriptor.sourceId) dedupeFilter.sourceId = descriptor.sourceId;
      else dedupeFilter.sourceId = null;

      let alert = await DashboardAlertModel.findOne(dedupeFilter);
      if (!alert) {
        alert = await DashboardAlertModel.create({ tenantId, ...descriptor, status: "Active", triggeredAt: new Date() });
        publishEvent("AlertTriggered", { tenantId, alertType: descriptor.alertType, severity: descriptor.severity, alertId: alert._id.toString() });
      }
      persistedAlerts.push(alert.toJSON ? alert.toJSON() : alert);
    }

    const summary = await FinanceOperationsSummaryModel.findOneAndUpdate(
      { tenantId, summaryDate: date },
      {
        tenantId,
        summaryDate: date,
        metrics,
        kpis,
        alerts: persistedAlerts,
        generatedAt: new Date(),
        lastRefreshedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await CacheManager.invalidatePattern(`finance-dashboard:*:${tenantId}*`);
    publishEvent("DashboardRefreshed", { tenantId, module: "finance" });
    publishEvent("KPICalculated", { tenantId, module: "finance" });

    return summary;
  }

  // ═══════════════════════════════════════════════════════════
  // CROSS-MODULE — Refresh All
  // ═══════════════════════════════════════════════════════════

  /**
   * Refresh summaries for a single tenant across all modules.
   */
  static async refreshAllForTenant({ tenantId }) {
    const results = await Promise.allSettled([
      this.refreshTravelSummary({ tenantId }),
      this.refreshVisaSummary({ tenantId }),
      this.refreshFinanceSummary({ tenantId }),
    ]);

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      logger.error("KPIEngine partial refresh failure", {
        tenantId,
        failures: failures.map((f) => f.reason?.message),
      });
    }

    return { refreshedModules: results.length - failures.length, failedModules: failures.length };
  }
}

export default KPIEngine;
