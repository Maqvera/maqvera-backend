import mongoose from "mongoose";

const TravelerServiceAssignmentSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  travelerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_traveler",
    required: true,
    index: true
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_service",
    required: true,
    index: true
  },
  // Copied directly from BookingServiceModel.serviceType on assignment — kept
  // identical to that enum so no valid service type can fail validation here.
  serviceType: {
    type: String,
    enum: ["package", "flight", "hotel", "room", "visa", "transport", "insurance", "guide", "meals", "meal_plan", "ziyarat", "activity", "addon", "other"],
    required: true
  },
  status: {
    type: String,
    enum: ["assigned", "unassigned", "cancelled"],
    default: "assigned",
    index: true
  },
  assignmentDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

TravelerServiceAssignmentSchema.index({ bookingId: 1, travelerId: 1, serviceId: 1 }, { unique: true });
TravelerServiceAssignmentSchema.index({ tenantId: 1, bookingId: 1 });

const TravelerServiceAssignmentModel = mongoose.model("traveler_service_assignment", TravelerServiceAssignmentSchema);

export default TravelerServiceAssignmentModel;
