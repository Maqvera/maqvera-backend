import mongoose from "mongoose";

const BookingTimelineSchema = new mongoose.Schema({
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
  entityType: {
    type: String,
    enum: ["Booking", "Visa", "Payment", "Customer", "Employee", "Supplier"],
    default: "Booking",
    index: true
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true
  },
  module: {
    type: String,
    default: "Booking"
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    default: null
  },
  description: {
    type: String,
    required: true
  },
  performedBy: {
    type: String,
    default: null
  },
  performedByName: {
    type: String,
    default: null
  },
  referenceId: {
    type: String,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

BookingTimelineSchema.index({ bookingId: 1, tenantId: 1, createdAt: -1 });
BookingTimelineSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

const BookingTimelineModel = mongoose.model("booking_timeline", BookingTimelineSchema);

export default BookingTimelineModel;
