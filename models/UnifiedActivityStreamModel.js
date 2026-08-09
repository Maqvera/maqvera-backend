import mongoose from "mongoose";

const UnifiedActivityStreamSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  module: {
    type: String,
    enum: ["Booking", "TravelOperations", "FlightOperations", "HotelOperations", "TransportManagement", "ItineraryManagement", "AttendanceManagement", "IncidentManagement", "Customer", "Finance", "Visa"],
    required: true,
    index: true
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  severity: {
    type: String,
    enum: ["Info", "Warning", "High", "Critical"],
    default: "Info"
  },
  performedBy: {
    type: String,
    default: null
  },
  performedByName: {
    type: String,
    default: "Staff"
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

UnifiedActivityStreamSchema.index({ tenantId: 1, referenceId: 1, createdAt: -1 });

const UnifiedActivityStreamModel = mongoose.model("unified_activity_stream", UnifiedActivityStreamSchema);

export default UnifiedActivityStreamModel;
