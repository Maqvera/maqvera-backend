import mongoose from "mongoose";

const BookingNoteSchema = new mongoose.Schema({
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
  authorId: {
    type: String,
    default: null
  },
  authorName: {
    type: String,
    default: "System"
  },
  category: {
    type: String,
    enum: ["Operations", "Finance", "Customer Service", "Sales", "Visa", "General"],
    default: "Operations"
  },
  visibility: {
    type: String,
    enum: ["Internal", "External", "Public"],
    default: "Internal"
  },
  content: {
    type: String,
    required: true
  },
  isImportant: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ["active", "archived"],
    default: "active",
    index: true
  }
}, { timestamps: true });

BookingNoteSchema.index({ bookingId: 1, tenantId: 1, status: 1, createdAt: -1 });

const BookingNoteModel = mongoose.model("booking_note", BookingNoteSchema);

export default BookingNoteModel;
