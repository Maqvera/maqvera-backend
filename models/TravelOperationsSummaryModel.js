import mongoose from "mongoose";

const TravelOperationsSummarySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    default: "all",
    index: true
  },
  summaryDate: {
    type: String, // YYYY-MM-DD
    required: true,
    index: true
  },
  metrics: {
    activeTravelPlans: { type: Number, default: 0 },
    todaysDepartures: { type: Number, default: 0 },
    todaysArrivals: { type: Number, default: 0 },
    travelersInTransit: { type: Number, default: 0 },
    travelersCheckedIn: { type: Number, default: 0 },
    pendingCheckIns: { type: Number, default: 0 },
    delayedFlights: { type: Number, default: 0 },
    pendingHotelCheckIns: { type: Number, default: 0 },
    openIncidents: { type: Number, default: 0 },
    criticalIncidents: { type: Number, default: 0 },
    emergencyCases: { type: Number, default: 0 },
    tasksDueToday: { type: Number, default: 0 },
    upcomingActivities: { type: Number, default: 0 },
    completedActivities: { type: Number, default: 0 },
    operationalHealthScore: { type: Number, default: 0 },
    // Response Includes (Part 10) names "Transport Status" — was computed
    // by KPIEngine.computeTravelMetrics but never persisted anywhere.
    transportStatus: {
      active: { type: Number, default: 0 },
      delayed: { type: Number, default: 0 },
      completed: { type: Number, default: 0 }
    }
  },
  kpis: {
    onTimeDeparturePct: { type: Number, default: 0 },
    onTimeArrivalPct: { type: Number, default: 0 },
    hotelCheckInSuccessPct: { type: Number, default: 0 },
    attendancePct: { type: Number, default: 0 },
    travelerSatisfaction: { type: Number, default: 0 },
    incidentRatePct: { type: Number, default: 0 },
    emergencyCount: { type: Number, default: 0 },
    tripCompletionPct: { type: Number, default: 0 },
    avgDelayMinutes: { type: Number, default: 0 },
    avgIncidentResolutionHours: { type: Number, default: 0 },
    vehicleUtilizationPct: { type: Number, default: 0 },
    // "Average Response Time" (Part 10 KPI list) — distinct from resolution
    // time; computed from TravelIncidentManagementModel.slaStatus's real
    // firstResponse tracking (Part 8).
    avgResponseTimeHours: { type: Number, default: 0 },
    // "Guide Performance" — % of guide-assigned itinerary activities
    // completed (real, derived from TravelItineraryModel), not a fabricated
    // score. "Customer Complaints" has no backing model anywhere in this
    // codebase — kept at the honest default (0, matching this file's own
    // established convention for travelerSatisfaction below) rather than
    // fabricated.
    guidePerformancePct: { type: Number, default: 0 },
    customerComplaintsCount: { type: Number, default: 0 }
  },
  workloadSummary: {
    coordinatorsActive: { type: Number, default: 0 },
    guidesActive: { type: Number, default: 0 },
    avgTasksPerCoordinator: { type: Number, default: 0 }
  },
  aiInsights: [
    {
      insightType: { type: String },
      message: { type: String },
      severity: { type: String, enum: ["Info", "Warning", "Critical"], default: "Info" },
      score: { type: Number }
    }
  ],
  lastRefreshedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

TravelOperationsSummarySchema.index({ tenantId: 1, branchId: 1, summaryDate: 1 }, { unique: true });

const TravelOperationsSummaryModel = mongoose.model("travel_operations_summary", TravelOperationsSummarySchema);

export default TravelOperationsSummaryModel;
