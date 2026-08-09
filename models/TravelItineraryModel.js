import mongoose from "mongoose";

const TravelItinerarySchema = new mongoose.Schema({
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
  day: {
    type: Number,
    required: true,
    min: 1,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  activityType: {
    type: String,
    enum: ["Airport", "Flight", "Hotel", "Transport", "Meal", "Prayer", "Ziyarat", "Shopping", "Meeting", "Rest", "Medical", "Custom"],
    default: "Ziyarat",
    index: true
  },
  plannedStart: {
    type: Date,
    required: true
  },
  plannedEnd: {
    type: Date,
    required: true
  },
  // "Supports timezone conversion" / AI Coding Rule "Timezone Aware." The
  // IANA zone plannedStart/plannedEnd were originally entered in (as local
  // wall-clock time) before being converted to the UTC Date stored above —
  // kept for display/round-tripping.
  timezone: {
    type: String,
    default: null
  },
  actualStart: {
    type: Date,
    default: null
  },
  actualEnd: {
    type: Date,
    default: null
  },
  estimatedDurationMinutes: {
    type: Number,
    default: 60
  },
  location: {
    locationId: { type: String, default: null },
    name: { type: String, default: null },
    address: { type: String, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null }
  },
  // "Activity Resources": Guide, Vehicle, Driver, Hotel, Meeting Room,
  // Equipment, Translator — "equipment" was missing from the original 7.
  resources: {
    guideId: { type: String, default: null },
    guideName: { type: String, default: null },
    vehicleId: { type: String, default: null },
    vehicleNumber: { type: String, default: null },
    driverId: { type: String, default: null },
    driverName: { type: String, default: null },
    hotelId: { type: String, default: null },
    hotelName: { type: String, default: null },
    meetingRoom: { type: String, default: null },
    equipment: [String],
    translatorName: { type: String, default: null }
  },
  assignedTravelers: [
    {
      travelerId: { type: mongoose.Schema.Types.ObjectId, required: true },
      travelerName: { type: String, default: null },
      attendanceStatus: {
        type: String,
        enum: ["Pending", "Present", "Absent", "Excused"],
        default: "Pending"
      }
    }
  ],
  // Directed Activity Graph (DAG) dependencies for automatic delay propagation
  dependsOnActivityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_itinerary",
    default: null,
    index: true
  },
  blocksActivityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_itinerary",
    default: null
  },
  slackTimeMinutes: {
    type: Number,
    default: 15
  },
  // "Supports recurring activities" / "Supports templates" — tags
  // activities created together via a recurrence request, or cloned from
  // a template activity, for traceability. Not required for standalone
  // activities.
  recurrenceGroupId: {
    type: String,
    default: null,
    index: true
  },
  clonedFromActivityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "travel_itinerary",
    default: null
  },
  status: {
    type: String,
    enum: [
      "draft",
      "planned",
      "published",
      "in_progress",
      "completed",
      "delayed",
      "cancelled",
      "skipped",
      "rescheduled",
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

TravelItinerarySchema.index({ travelPlanId: 1, tenantId: 1, day: 1, plannedStart: 1 });

const TravelItineraryModel = mongoose.model("travel_itinerary", TravelItinerarySchema);

export default TravelItineraryModel;
