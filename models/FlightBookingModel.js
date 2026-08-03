import mongoose from "mongoose";

const FlightBookingSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingHeader", index: true, default: null },
    travelPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "TravelPlan", index: true, default: null },
    offerId: { type: String, required: true },
    provider: { type: String, required: true, enum: ["Amadeus", "Sabre", "Travelport", "DirectAirline"], default: "Amadeus" },
    pnr: { type: String, required: true, index: true },
    providerBookingReference: { type: String, required: true },
    status: {
      type: String,
      enum: ["Offer Selected", "Pending Validation", "Reserved", "Awaiting Ticketing", "Ticketed", "Completed", "Cancelled", "Expired", "Rejected", "Failed"],
      default: "Reserved",
      index: true
    },
    ticketStatus: {
      type: String,
      enum: ["Not Issued", "Issued", "Voided", "Reissued", "Refund Requested", "Refunded"],
      default: "Not Issued",
      index: true
    },
    ticketNumbers: [{ type: String }],
    paymentReference: { type: String, default: null },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null },
    reissueHistory: [
      {
        oldTicketNumbers: [{ type: String }],
        newTicketNumbers: [{ type: String }],
        newFlightOfferId: { type: String },
        reason: { type: String },
        fareDiff: { type: Number, default: 0 },
        reissuedAt: { type: Date, default: Date.now }
      }
    ],
    refundDetails: {
      refundAmount: { type: Number, default: 0 },
      penaltyFee: { type: Number, default: 0 },
      status: { type: String, default: null },
      requestedAt: { type: Date, default: null },
      reason: { type: String, default: null }
    },
    ssr: [
      {
        code: { type: String, required: true },
        description: { type: String },
        travelerId: { type: String },
        status: { type: String, default: "CONFIRMED" },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    osi: [
      {
        code: { type: String, required: true },
        remark: { type: String, required: true },
        travelerId: { type: String },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    emd: [
      {
        emdNumber: { type: String, required: true },
        serviceType: { type: String, required: true },
        amount: { type: Number, required: true },
        status: { type: String, default: "ISSUED" },
        issuedAt: { type: Date, default: Date.now }
      }
    ],
    totalPrice: { type: Number, required: true },
    currency: { type: String, default: "PKR" },
    ticketingDeadline: { type: Date, default: null },
    travelers: [
      {
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        gender: { type: String, enum: ["Male", "Female", "Other"], default: "Male" },
        dateOfBirth: { type: Date },
        passportNumber: { type: String, required: true },
        passportExpiry: { type: Date },
        nationality: { type: String, default: "PK" },
        seatNumber: { type: String, default: null },
        ticketNumber: { type: String, default: null }
      }
    ],
    contact: {
      email: { type: String, default: null },
      phone: { type: String, default: null }
    },
    segments: [
      {
        airline: { type: String },
        airlineCode: { type: String },
        flightNumber: { type: String },
        origin: { type: String },
        destination: { type: String },
        departure: { type: Date },
        arrival: { type: Date },
        cabin: { type: String, default: "Economy" },
        fareFamily: { type: String, default: "Standard Economy" }
      }
    ],
    fareBreakdown: {
      baseFare: { type: Number, default: 0 },
      taxes: { type: Number, default: 0 },
      serviceFee: { type: Number, default: 0 },
      discount: { type: Number, default: 0 }
    },
    cancellationReason: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: null },
    lastSynchronizedAt: { type: Date, default: Date.now },
    version: { type: Number, default: 1 },
    versionHistory: [
      {
        version: { type: Number },
        updatedBy: { type: String },
        updatedAt: { type: Date, default: Date.now },
        changes: { type: Object }
      }
    ]
  },
  { timestamps: true }
);

FlightBookingSchema.index({ tenantId: 1, pnr: 1 }, { unique: true });

export default mongoose.models.FlightBooking || mongoose.model("FlightBooking", FlightBookingSchema);
