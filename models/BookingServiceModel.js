import mongoose from "mongoose";

const BookingServiceSchema = new mongoose.Schema({
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
  serviceType: {
    type: String,
    enum: ["package", "flight", "hotel", "room", "visa", "transport", "insurance", "guide", "meals", "meal_plan", "ziyarat", "activity", "addon", "other"],
    required: true,
    index: true
  },
  serviceCategory: {
    type: String,
    enum: ["transportation", "accommodation", "immigration", "insurance", "tour", "food", "religious", "entertainment", "other"],
    default: "other",
    index: true
  },
  serviceName: {
    type: String,
    required: true
  },
  supplierId: {
    type: String,
    default: null,
    index: true
  },
  supplierName: {
    type: String,
    default: null
  },
  costPrice: {
    type: Number,
    default: 0
  },
  sellingPrice: {
    type: Number,
    default: 0
  },
  quantity: {
    type: Number,
    default: 1
  },
  totalPrice: {
    type: Number,
    default: 0
  },
  currencyId: {
    type: String,
    default: "USD"
  },
  startDate: {
    type: Date,
    default: null
  },
  endDate: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "archived"],
    default: "active",
    index: true
  },
  workflowStatus: {
    type: String,
    enum: ["created", "reserved", "confirmed", "in_progress", "completed", "cancelled", "expired", "failed"],
    default: "created",
    index: true
  },
  remarks: {
    type: String,
    default: null
  },
  internalNotes: {
    type: String,
    default: null
  },
  priority: {
    type: String,
    enum: ["normal", "medium", "high", "vip"],
    default: "normal"
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

BookingServiceSchema.index({ bookingId: 1, tenantId: 1, serviceType: 1, status: 1 });

const BookingServiceModel = mongoose.model("booking_service", BookingServiceSchema);

export default BookingServiceModel;
