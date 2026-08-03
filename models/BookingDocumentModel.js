import mongoose from "mongoose";

const BookingDocumentSchema = new mongoose.Schema({
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
  fileName: {
    type: String,
    required: true
  },
  // Internal storage pointer — never returned in API responses. When
  // present, the response's fileUrl is computed as a short-lived signed URL
  // (EnterpriseDocumentService.generateSignedUrl) instead of a permanent one.
  storageKey: {
    type: String,
    default: null
  },
  fileUrl: {
    type: String,
    required: true
  },
  fileType: {
    type: String,
    default: "application/pdf"
  },
  fileSize: {
    type: Number,
    default: 0
  },
  category: {
    type: String,
    enum: ["Agreement", "Quotation", "Itinerary", "Flight Ticket", "Hotel Voucher", "Insurance Certificate", "Payment Receipt", "Visa Approval", "Other"],
    default: "Other",
    index: true
  },
  version: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ["pending_scan", "verified", "rejected", "archived"],
    default: "pending_scan",
    index: true
  },
  virusScanStatus: {
    type: String,
    enum: ["pending", "clean", "infected"],
    default: "pending"
  },
  verifiedBy: {
    type: String,
    default: null
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  rejectionReason: {
    type: String,
    default: null
  },
  uploadedBy: {
    type: String,
    default: null
  },
  uploadedByName: {
    type: String,
    default: "Staff"
  }
}, { timestamps: true });

BookingDocumentSchema.index({ bookingId: 1, tenantId: 1, status: 1, createdAt: -1 });

const BookingDocumentModel = mongoose.model("booking_document", BookingDocumentSchema);

export default BookingDocumentModel;
