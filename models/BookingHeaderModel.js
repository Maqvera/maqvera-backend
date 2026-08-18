import mongoose from "mongoose";

const BookingHeaderSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Immutable once assigned — generated server-side via NumberGeneratorService,
  // never caller-supplied (mirrors InvoiceModel.js's invoiceNumber pattern).
  bookingReference: {
    type: String,
    required: true,
    immutable: true
  },
  bookingNumber: {
    type: String,
    index: true,
    immutable: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  customerCode: {
    type: String,
    default: null
  },
  customerName: {
    type: String,
    default: null
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  bookingType: {
    type: String,
    enum: ["umrah", "hajj", "visa_only", "flight_only", "hotel_only", "transportation", "holiday_package", "corporate_travel", "custom_package"],
    default: "umrah",
    index: true
  },
  // Matches the workflow engine's Booking Workflow Lifecycle (Part 5,
  // utils/bookingConfig.js's workflowStates) exactly, since this field is
  // the denormalized mirror of WorkflowInstanceModel.currentState.
  status: {
    type: String,
    enum: ["draft", "quotation", "reserved", "confirmed", "deposit_received", "visa_processing", "ticket_issued", "travel_ready", "traveling", "completed", "cancelled", "refund_requested", "refund_completed", "archived"],
    default: "draft",
    index: true
  },
  priority: {
    type: String,
    enum: ["normal", "medium", "high", "vip"],
    default: "normal"
  },
  paymentStatus: {
    type: String,
    enum: ["unpaid", "partially_paid", "fully_paid", "refunded"],
    default: "unpaid",
    index: true
  },
  visaStatus: {
    type: String,
    enum: ["not_required", "pending", "submitted", "processing", "approved", "rejected"],
    default: "pending",
    index: true
  },
  assignedTo: {
    type: String,
    default: null,
    index: true
  },
  assignedConsultant: {
    type: String,
    default: null
  },
  travelDate: {
    type: Date,
    default: null,
    index: true
  },
  returnDate: {
    type: Date,
    default: null
  },
  totalAmount: {
    type: Number,
    default: 0
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: "USD"
  },
  remarks: {
    type: String,
    default: null
  },
  internalNotes: {
    type: String,
    default: null
  },
  preferredContactTime: {
    type: String,
    default: null
  },
  financialSnapshot: {
    packagePrice: { type: Number, default: 0 },
    discounts: { type: Number, default: 0 },
    taxes: { type: Number, default: 0 },
    serviceCharges: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    outstandingBalance: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    paymentStatus: { type: String, default: "unpaid" },
    lastCalculatedAt: { type: Date, default: Date.now },
    // Set by BookingFinanceLinkService once a real Finance-module Invoice
    // has been issued for this booking (see that service's doc comment) —
    // null for bookings created before that link existed, or for a $0
    // booking that never had anything to bill.
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "invoice", default: null },
    invoiceNumber: { type: String, default: null }
  }
}, { timestamps: true });

BookingHeaderSchema.index({ tenantId: 1, bookingReference: 1 }, { unique: true });
BookingHeaderSchema.index({ tenantId: 1, status: 1 });
BookingHeaderSchema.index({ customerId: 1, tenantId: 1 });
BookingHeaderSchema.index({ tenantId: 1, travelDate: 1 });
BookingHeaderSchema.index({ tenantId: 1, createdAt: -1 });
BookingHeaderSchema.index({ tenantId: 1, assignedConsultant: 1 });

const BookingHeaderModel = mongoose.model("booking_header", BookingHeaderSchema);

export default BookingHeaderModel;
