import mongoose from "mongoose";

const BookingTaskSchema = new mongoose.Schema({
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
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: null
  },
  assignedTo: {
    type: String,
    default: null,
    index: true
  },
  assignedToName: {
    type: String,
    default: null
  },
  dueDate: {
    type: Date,
    default: null,
    index: true
  },
  priority: {
    type: String,
    enum: ["low", "normal", "high", "urgent"],
    default: "normal",
    index: true
  },
  workflowStatus: {
    type: String,
    enum: ["created", "assigned", "in_progress", "completed", "cancelled", "overdue"],
    default: "created",
    index: true
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "archived"],
    default: "active",
    index: true
  },
  createdBy: {
    type: String,
    default: null
  },
  createdByName: {
    type: String,
    default: "Staff"
  }
}, { timestamps: true });

BookingTaskSchema.index({ bookingId: 1, tenantId: 1, status: 1, createdAt: -1 });

const BookingTaskModel = mongoose.model("booking_task", BookingTaskSchema);

export default BookingTaskModel;
