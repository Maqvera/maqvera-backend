import mongoose from "mongoose";

const TravelHotelAssignmentSchema = new mongoose.Schema({
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
  hotelCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "hotel_catalog",
    default: null
  },
  hotelName: {
    type: String,
    required: true
  },
  city: {
    type: String,
    required: true,
    index: true
  },
  country: {
    type: String,
    default: "Saudi Arabia"
  },
  starRating: {
    type: Number,
    default: 5
  },
  supplier: {
    type: String,
    default: "Direct Hotel Contract"
  },
  plannedCheckIn: {
    type: Date,
    required: true
  },
  plannedCheckOut: {
    type: Date,
    required: true
  },
  actualCheckIn: {
    type: Date,
    default: null
  },
  actualCheckOut: {
    type: Date,
    default: null
  },
  numberOfNights: {
    type: Number,
    default: 1
  },
  mealPlan: {
    type: String,
    enum: ["Room Only", "Breakfast", "Half Board", "Full Board", "All Inclusive", "Custom"],
    default: "Breakfast",
    index: true
  },
  status: {
    type: String,
    enum: [
      "planned",
      "reserved",
      "confirmed",
      "ready",
      "checked_in",
      "occupied",
      "checked_out",
      "completed",
      "delayed",
      "room_change",
      "overbooking",
      "cancelled",
      "maintenance_issue",
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
      travelerName: { type: String, default: null }
    }
  ],
  rooms: [
    {
      roomInventoryId: { type: mongoose.Schema.Types.ObjectId, ref: "hotel_room_inventory", default: null },
      roomType: { type: String, required: true },
      roomNumber: { type: String, required: true },
      capacity: { type: Number, required: true, default: 4 },
      occupancy: { type: Number, default: 0 },
      travelerIds: [{ type: mongoose.Schema.Types.ObjectId }],
      travelers: [
        {
          travelerId: { type: mongoose.Schema.Types.ObjectId, required: true },
          travelerName: { type: String, default: null }
        }
      ],
      // Business Rule: "Supports gender policies." No explicit policy rule
      // is given (e.g. blocking behavior for exceptions like family/mahram
      // groupings isn't specified), so this is computed and surfaced as a
      // real, queryable flag rather than silently ignored or a hard block
      // that could reject legitimate family bookings.
      hasMixedGenderOccupancy: { type: Boolean, default: false }
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

TravelHotelAssignmentSchema.index({ travelPlanId: 1, tenantId: 1 });
TravelHotelAssignmentSchema.index({ plannedCheckIn: 1, plannedCheckOut: 1 });

const TravelHotelAssignmentModel = mongoose.model("travel_hotel_assignment", TravelHotelAssignmentSchema);

export default TravelHotelAssignmentModel;
