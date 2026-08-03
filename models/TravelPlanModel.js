import mongoose from "mongoose";

const TravelPlanSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    required: true,
    index: true
  },
  travelPlanNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    required: true,
    index: true
  },
  bookingNumber: {
    type: String,
    required: true
  },
  bookingSnapshot: {
    bookingReference: String,
    customerId: mongoose.Schema.Types.ObjectId,
    customerName: String,
    customerCode: String,
    bookingType: String,
    packageId: mongoose.Schema.Types.ObjectId,
    totalAmount: Number,
    currency: { type: String, default: "USD" },
    paymentStatus: String,
    visaStatus: String
  },
  travelerSnapshots: [
    {
      travelerId: mongoose.Schema.Types.ObjectId,
      title: String,
      firstName: String,
      lastName: String,
      fullName: String,
      passportNumber: String,
      passportExpiry: Date,
      gender: String,
      dateOfBirth: Date,
      nationality: String,
      phone: String,
      roomPreference: String,
      specialRequests: String
    }
  ],
  travelType: {
    type: String,
    enum: ["umrah", "hajj", "international_tour", "domestic_tour", "corporate_travel", "business_visit", "educational_tour", "vip_travel", "custom_travel"],
    default: "umrah",
    index: true
  },
  // Matches utils/travelConfig.js's travelStatuses exactly (Section 4's
  // 11-step lifecycle plus its 6 named exceptions).
  status: {
    type: String,
    enum: [
      "planning",
      "ready",
      "departure_scheduled",
      "checked_in",
      "in_transit",
      "arrived",
      "hotel_checked_in",
      "tour_active",
      "tour_completed",
      "return_journey",
      "completed",
      "archived",
      "delayed",
      "cancelled",
      "emergency",
      "medical_assistance",
      "lost_traveler",
      "missed_flight"
    ],
    default: "planning",
    index: true
  },
  priority: {
    type: String,
    enum: ["normal", "medium", "high", "vip"],
    default: "normal"
  },
  departureDate: {
    type: Date,
    required: true,
    index: true
  },
  arrivalDate: {
    type: Date,
    required: true
  },
  travelCoordinatorId: {
    type: String,
    default: null,
    index: true
  },
  coordinator: {
    type: String,
    default: null
  },
  assignedTeam: [
    {
      memberId: String,
      name: String,
      role: String
    }
  ],
  emergencyContact: {
    name: { type: String, default: null },
    phone: { type: String, default: null },
    relationship: { type: String, default: null }
  },
  internalRemarks: {
    type: String,
    default: null
  },
  checklists: [
    {
      title: { type: String, required: true },
      isCompleted: { type: Boolean, default: false },
      completedAt: { type: Date, default: null },
      completedBy: { type: String, default: null }
    }
  ],
  isArchived: {
    type: Boolean,
    default: false,
    index: true
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

TravelPlanSchema.index({ tenantId: 1, branchId: 1, status: 1 });
TravelPlanSchema.index({ bookingId: 1, tenantId: 1 });
TravelPlanSchema.index({ tenantId: 1, departureDate: 1 });
// Part 2 business rule "Supports indexed filtering" — arrivalDateFrom/
// arrivalDateTo are real ListTravelPlans query params but arrivalDate had
// no index at all (departureDate did).
TravelPlanSchema.index({ tenantId: 1, arrivalDate: 1 });

const TravelPlanModel = mongoose.model("travel_plan", TravelPlanSchema);

export default TravelPlanModel;
