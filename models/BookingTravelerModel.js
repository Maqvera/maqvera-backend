import mongoose from "mongoose";

const BookingTravelerSchema = new mongoose.Schema({
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
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  isPrimary: {
    type: Boolean,
    default: false
  },
  isPrimaryTraveler: {
    type: Boolean,
    default: false
  },
  travelerType: {
    type: String,
    enum: ["adult", "child", "infant", "senior_citizen", "special_assistance", "vip", "mahram", "dependent"],
    default: "adult",
    index: true
  },
  travelerStatus: {
    type: String,
    enum: ["registered", "documents_pending", "visa_processing", "visa_approved", "ticket_issued", "checked_in", "traveling", "completed", "cancelled", "no_show", "rejected"],
    default: "registered",
    index: true
  },
  // Traveler Customer Snapshot pattern to preserve historical profile state
  customerSnapshot: {
    snapshotName: { type: String, required: true },
    snapshotPassportNumber: { type: String, default: null },
    snapshotPassportExpiry: { type: Date, default: null },
    snapshotNationality: { type: String, default: null },
    snapshotDateOfBirth: { type: Date, default: null },
    snapshotGender: { type: String, default: null },
    snapshotEmail: { type: String, default: null },
    snapshotPhone: { type: String, default: null },
    snapshotCreatedAt: { type: Date, default: Date.now }
  },
  // Basic info fields for quick indexing / fallback
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  gender: { type: String, enum: ["male", "female", "other"], default: null },
  dateOfBirth: { type: Date, default: null },
  passportNumber: { type: String, default: null },
  passportExpiry: { type: Date, default: null },
  nationality: { type: String, default: null },
  
  // Editable booking-specific preferences & assignments
  mealPreference: { type: String, default: null },
  wheelchairRequired: { type: Boolean, default: false },
  specialAssistance: { type: String, default: null },
  emergencyContact: {
    name: { type: String, default: null },
    phone: { type: String, default: null },
    relationship: { type: String, default: null }
  },
  roomPreference: { type: String, default: null },
  seatPreference: { type: String, default: null },
  medicalNotes: { type: String, default: null },
  baggageRequirement: { type: String, default: null },
  priority: { type: String, enum: ["normal", "high", "vip"], default: "normal" },
  roomAssignment: { type: String, default: null },
  seatAssignment: { type: String, default: null },
  visaStatus: {
    type: String,
    enum: ["not_required", "pending", "submitted", "processing", "approved", "rejected"],
    default: "pending",
    index: true
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "archived"],
    default: "active",
    index: true
  }
}, { timestamps: true });

BookingTravelerSchema.index({ bookingId: 1, tenantId: 1, status: 1 });
BookingTravelerSchema.index({ customerId: 1, bookingId: 1 });

const BookingTravelerModel = mongoose.model("booking_traveler", BookingTravelerSchema);

export default BookingTravelerModel;
