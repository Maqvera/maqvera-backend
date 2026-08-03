import mongoose from "mongoose";

const TravelFlightAssignmentSchema = new mongoose.Schema({
  travelPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_plan",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    default: "default"
  },
  flightCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "flight_catalog",
    default: null
  },
  airline: {
    type: String,
    required: true
  },
  flightNumber: {
    type: String,
    required: true,
    index: true
  },
  originAirport: {
    type: String,
    required: true
  },
  destinationAirport: {
    type: String,
    required: true
  },
  plannedDeparture: {
    type: Date,
    required: true
  },
  plannedArrival: {
    type: Date,
    required: true
  },
  actualDeparture: {
    type: Date,
    default: null
  },
  actualArrival: {
    type: Date,
    default: null
  },
  terminal: {
    type: String,
    default: null
  },
  gate: {
    type: String,
    default: null
  },
  aircraft: {
    type: String,
    default: "Boeing 777"
  },
  durationMinutes: {
    type: Number,
    default: 0
  },
  // Matches utils/flightConfig.js's flightStatuses exactly (Flight Lifecycle
  // diagram plus its named exceptions, including "diversion" which the
  // original enum was missing).
  status: {
    type: String,
    enum: [
      "scheduled",
      "confirmed",
      "ticket_issued",
      "check_in_open",
      "checked_in",
      "boarding",
      "departed",
      "in_flight",
      "arrived",
      "completed",
      "delayed",
      "cancelled",
      "missed_flight",
      "rescheduled",
      "diversion",
      "emergency"
    ],
    default: "scheduled",
    index: true
  },
  priority: {
    type: String,
    enum: ["normal", "medium", "high", "vip"],
    default: "normal"
  },
  internalNotes: {
    type: String,
    default: null
  },
  remarks: {
    type: String,
    default: null
  },
  assignedTravelers: [
    {
      travelerId: { type: mongoose.Schema.Types.ObjectId, required: true },
      travelerName: { type: String, default: null },
      seatNumber: { type: String, default: null },
      boardingStatus: {
        type: String,
        enum: ["Not Boarded", "Boarded", "Missed Boarding", "Denied Boarding"],
        default: "Not Boarded"
      },
      checkInStatus: {
        type: String,
        enum: ["Pending", "Checked In", "Baggage Dropped"],
        default: "Pending"
      },
      baggageCount: { type: Number, default: 0 }
    }
  ],
  // AI Coding Rule: "Never overwrite historical records." Was previously a
  // single embedded object that got merge-overwritten on every delay report
  // — a second delay event (e.g. weather delay, then later a separate
  // technical delay) would silently erase the first. Append-only log instead.
  delayHistory: [
    {
      reason: { type: String, default: null },
      expectedDelayMinutes: { type: Number, default: 0 },
      actualDelayMinutes: { type: Number, default: 0 },
      resolution: { type: String, default: null },
      responsibleParty: { type: String, default: null },
      reportedAt: { type: Date, default: Date.now },
      reportedBy: { type: String, default: null }
    }
  ],
  incidents: [
    {
      incidentType: { type: String, required: true },
      severity: { type: String, enum: ["Low", "Medium", "High", "Critical"], default: "Medium" },
      description: { type: String, required: true },
      reportedAt: { type: Date, default: Date.now },
      reportedBy: { type: String, default: null },
      resolution: { type: String, default: null }
    }
  ],
  version: {
    type: Number,
    default: 1
  },
  versionHistory: [
    {
      version: Number,
      updatedBy: String,
      updatedAt: { type: Date, default: Date.now },
      changes: mongoose.Schema.Types.Mixed
    }
  ]
}, { timestamps: true });

TravelFlightAssignmentSchema.index({ travelPlanId: 1, tenantId: 1 });
TravelFlightAssignmentSchema.index({ flightNumber: 1, plannedDeparture: 1 });

const TravelFlightAssignmentModel = mongoose.model("travel_flight_assignment", TravelFlightAssignmentSchema);

export default TravelFlightAssignmentModel;
