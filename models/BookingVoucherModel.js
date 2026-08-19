import mongoose from "mongoose";

// Agency/tenant-branded Client Voucher (booking-module PRD Part B item #7)
// — NOT the same concept as HotelBookingModel.voucherNumber/voucherUrl,
// which is the GDS supplier's own confirmation voucher (Amadeus/Sabre).
// This model is this tenant's own document: company logo, client/guest
// detail, terms, cancellation policy — generated from this codebase's own
// data, never from a supplier response.
const BookingVoucherSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "booking_header",
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side via NumberGeneratorService
  // (resourceType "Voucher"), never caller-supplied.
  voucherNumber: {
    type: String,
    required: true,
    immutable: true
  },
  pdfUrl: {
    type: String,
    default: null
  },
  // Per-document QR access token — generated once, immutable for the life
  // of the voucher (same stability guarantee as voucherNumber). See
  // services/InvoiceDocumentQrService.js.
  qrAccessToken: { type: String, default: null, unique: true, sparse: true },
  // Snapshot-over-live (PRD Part B item #12's flagged-but-unresolved
  // question — implemented per this codebase's own existing convention:
  // InvoiceLineItemSchema already denormalizes tax amounts "so a historical
  // version snapshot shows exactly what was billed, even if tax
  // configuration changes later." A voucher's rendered content is frozen
  // at generation time here for the same reason; if the booking is edited
  // afterward, this snapshot does NOT get updated — a new voucher must be
  // generated to reflect new data. Flagged in the implementation report as
  // an assumption, not a confirmed business decision.
  snapshotData: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  generatedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  generatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

BookingVoucherSchema.index({ tenantId: 1, bookingId: 1, createdAt: -1 });

BookingVoucherSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BookingVoucherModel = mongoose.model("booking_voucher", BookingVoucherSchema);

export default BookingVoucherModel;
