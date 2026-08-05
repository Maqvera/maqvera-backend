import mongoose from "mongoose";

const FlightBookingSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingHeader", index: true, default: null },
    travelPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "TravelPlan", index: true, default: null },
    // EXT-004 — "Aggregate Relationship: Travel Plan > Flight Assignment >
    // Airline Booking/PNR/Order ID/Snapshot". Links this booking to the
    // specific Travel Operations flight assignment it fulfills.
    flightAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "travel_flight_assignment", index: true, default: null },
    // Distinct from `pnr` (the airline record locator) — Amadeus's Flight
    // Create Orders response gives a separate order `id`, already stored in
    // `providerBookingReference` for Amadeus; this is an explicit, doc-named
    // alias so EXT-004's response DTO field name is self-evident.
    airlineOrderId: { type: String, default: null },
    // "Every booking stores the complete Amadeus response snapshot... never
    // edited... actual airline response always preserved." Set once at
    // creation and never mutated afterward by any controller in this
    // codebase.
    bookingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    // EXT-009 §16 "Database Synchronization: Flight Booking > Seat
    // Assignment". Doc's §9 says "Update Booking Snapshot" as a workflow
    // step, but EXT-004 established bookingSnapshot as immutable/never
    // edited after creation — resolved by recording seat assignments here
    // instead, never touching the original raw airline snapshot.
    seatAssignments: [
      {
        travelerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        segmentId: { type: String, required: true },
        seatNumber: { type: String, required: true },
        seatType: { type: String, default: "Standard" },
        status: { type: String, enum: ["Confirmed", "Released"], default: "Confirmed" },
        previousSeatNumber: { type: String, default: null },
        assignedBy: { type: String, default: null },
        assignedAt: { type: Date, default: Date.now }
      }
    ],
    offerId: { type: String, required: true },
    provider: { type: String, required: true, enum: ["Amadeus", "Sabre", "Travelport", "DirectAirline"], default: "Amadeus" },
    // EXT-010 — "Determine Airline" needs the real OPERATING/marketing
    // carrier, which is distinct from `provider` (the GDS, always "Amadeus"
    // here). Sourced from the real flight offer/segment data at booking
    // creation time (never guessed) — null when that data wasn't available,
    // which EXT-010 treats as a genuine validation failure rather than
    // assuming an airline.
    airlineCode: { type: String, default: null },
    airlineName: { type: String, default: null },
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
    // EXT-005 §13 "FlightBooking.ticketIssued = true" — a doc-named boolean
    // flag kept alongside the existing, already-depended-upon `ticketStatus`
    // enum (API-006D) rather than replacing it.
    ticketIssued: { type: Boolean, default: false, index: true },
    ticketNumbers: [{ type: String }],
    // EXT-005 §13 "Ticket Table > Insert Ticket Numbers" — a real, queryable
    // per-traveler ticket record (travelerId + ticket number + status),
    // distinct from the flat `ticketNumbers` string array above which
    // API-006D's void/reissue/refund flows already depend on.
    tickets: [
      {
        travelerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        ticketNumber: { type: String, required: true },
        status: { type: String, enum: ["Issued", "Voided", "Refunded", "Exchanged"], default: "Issued" },
        issuedAt: { type: Date, default: Date.now }
      }
    ],
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
        // EXT-004/EXT-005 linkage — the Travel Plan's own traveler snapshot
        // ID, so EXT-005's ticketing response can key `tickets[]` by the
        // same identifier the Travel Plan already uses for this person.
        travelerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        gender: { type: String, enum: ["Male", "Female", "Other"], default: "Male" },
        dateOfBirth: { type: Date },
        passportNumber: { type: String, required: true },
        passportExpiry: { type: Date },
        nationality: { type: String, default: "PK" },
        seatNumber: { type: String, default: null },
        ticketNumber: { type: String, default: null },
        // EXT-010 §11 response DTO "travelers[].boardingStatus".
        checkInStatus: { type: String, enum: ["Not Checked In", "Checked In"], default: "Not Checked In" }
      }
    ],
    // EXT-010 §10 "Boarding pass files stored in Object Storage. Only
    // metadata stored in [the database]." The actual file goes through the
    // same `saveBookingDocumentFile` object-storage abstraction already
    // used elsewhere in this codebase (Cloudinary/S3/local) — this array
    // holds only the returned pointer/metadata, never the raw file.
    boardingPasses: [
      {
        travelerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        segmentId: { type: String, default: null },
        fileName: { type: String, default: null },
        storedFileName: { type: String, default: null },
        storageProvider: { type: String, default: null },
        publicUrl: { type: String, default: null },
        mimeType: { type: String, default: "application/pdf" },
        size: { type: Number, default: 0 },
        issuedAt: { type: Date, default: Date.now }
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
