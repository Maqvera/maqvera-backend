import mongoose from "mongoose";

const TravelTransportAssignmentSchema = new mongoose.Schema({
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
  transportType: {
    type: String,
    enum: ["Airport Transfer", "Hotel Transfer", "Intercity Transfer", "Ziyarat Tour", "Custom Trip", "Return Transfer"],
    default: "Airport Transfer",
    index: true
  },
  journeySegment: {
    type: String,
    required: true,
    default: "Journey Segment 1: Airport to Hotel"
  },
  fleetResourceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "fleet_resource",
    default: null
  },
  vehicleNumber: {
    type: String,
    required: true
  },
  plateNumber: {
    type: String,
    default: null
  },
  vehicleType: {
    type: String,
    enum: ["Bus", "Coaster", "GMC", "SUV", "Sedan", "Van", "VIP Bus"],
    default: "Bus"
  },
  capacity: {
    type: Number,
    required: true,
    default: 50
  },
  driverId: {
    type: String,
    required: true
  },
  driverName: {
    type: String,
    required: true
  },
  driverPhone: {
    type: String,
    required: true
  },
  routeCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "route_catalog",
    default: null
  },
  routeName: {
    type: String,
    default: null
  },
  pickupLocation: {
    type: String,
    required: true
  },
  dropoffLocation: {
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
  // Matches utils/transportConfig.js's transportStatuses exactly (Transport
  // Lifecycle diagram plus its named exceptions — "driver_changed" and
  // "route_changed" were missing from the original enum).
  status: {
    type: String,
    enum: [
      "planned",
      "vehicle_assigned",
      "driver_assigned",
      "route_confirmed",
      "ready",
      "boarding",
      "departed",
      "in_transit",
      "arrived",
      "completed",
      "delayed",
      "traffic_delay",
      "breakdown",
      "driver_changed",
      "route_changed",
      "cancelled",
      "emergency"
    ],
    default: "planned",
    index: true
  },
  priority: {
    type: String,
    enum: ["normal", "medium", "high", "vip"],
    default: "normal"
  },
  remarks: {
    type: String,
    default: null
  },
  internalNotes: {
    type: String,
    default: null
  },
  assignedTravelers: [
    {
      travelerId: { type: mongoose.Schema.Types.ObjectId, required: true },
      travelerName: { type: String, default: null },
      boardingStatus: {
        type: String,
        enum: ["Not Boarded", "Boarded", "Missed Boarding"],
        default: "Not Boarded"
      },
      pickupStatus: {
        type: String,
        enum: ["Pending", "Picked Up", "No Show"],
        default: "Pending"
      },
      dropoffStatus: {
        type: String,
        enum: ["Pending", "Dropped Off"],
        default: "Pending"
      },
      seatNumber: { type: String, default: null }
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

TravelTransportAssignmentSchema.index({ travelPlanId: 1, tenantId: 1 });
TravelTransportAssignmentSchema.index({ plannedDeparture: 1, plannedArrival: 1 });

const TravelTransportAssignmentModel = mongoose.model("travel_transport_assignment", TravelTransportAssignmentSchema);

export default TravelTransportAssignmentModel;
