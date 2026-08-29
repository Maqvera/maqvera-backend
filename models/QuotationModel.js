import mongoose from "mongoose";

// Package Pricing Engine — PRD §89 "Quotation Generator" / §117 "Final
// Customer View". A Quotation freezes ONE room-wise matrix row (the
// customer picks a room type) into a customer-facing document — supplier
// cost, profit, and commission are deliberately never copied onto this
// model, matching PRD §117 ("Customer should NOT see supplier cost,
// profit... unless explicitly configured") and this codebase's own
// BookingVoucherModel snapshot-over-live-doc convention.
const QuotationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "package",
    required: true,
    index: true
  },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", default: null, index: true },
  quotationNumber: { type: String, required: true, index: true },
  roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "room_type", required: true },
  // Frozen at generation time — a later package recalculation never
  // silently changes an already-sent quotation (PRD §51/§52).
  snapshotData: { type: mongoose.Schema.Types.Mixed, required: true },
  termsAndConditions: { type: String, default: null },
  paymentTerms: { type: String, default: null },
  validUntil: { type: Date, default: null },
  status: { type: String, required: true, index: true },
  pdfUrl: { type: String, default: null },
  // Set once this quotation is turned into a real booking (PackagePricingService.
  // convertQuotationToBooking) — a quotation can only ever be converted once.
  convertedBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "booking_header", default: null },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, default: null }
}, { timestamps: true });

QuotationSchema.index({ tenantId: 1, packageId: 1, createdAt: -1 });

QuotationSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const QuotationModel = mongoose.model("package_quotation", QuotationSchema);

export default QuotationModel;
