import mongoose from "mongoose";

const HotelBookingSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "booking_header", index: true, default: null },
    travelPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "TravelPlan", index: true, default: null },
    offerId: { type: String, required: true },
    provider: {
      type: String,
      required: true,
      // "Amadeus"/"Sabre" are the only providers with a real registered
      // adapter (GdsIntegrationService.adapters) — every booking is created
      // with adapter.providerName, which is literally "Amadeus" or "Sabre".
      // The enum previously only listed aspirational supplier names
      // ("AmadeusHotels", "Hotelbeds", ...) that no adapter ever produces,
      // so every real booking failed Mongoose validation on save. Kept the
      // aspirational names too so adding a real Hotelbeds/Expedia adapter
      // later needs no migration.
      enum: ["Amadeus", "Sabre", "AmadeusHotels", "Hotelbeds", "Expedia", "BookingCom", "SabreHotels", "DirectHotel"],
      default: "Amadeus"
    },
    reservationNumber: { type: String, required: true, index: true },
    // EXT-022 §12/§13 — distinct from `reservationNumber` above (this
    // codebase's own internal identifier): the real Amadeus confirmation
    // number and internal booking ID, additive fields so the pre-existing
    // legacy hotel-distribution pipeline's writes (which never populate
    // these) remain valid.
    providerConfirmationNumber: { type: String, default: null },
    providerBookingId: { type: String, default: null },
    contact: {
      email: { type: String, default: null },
      phone: { type: String, default: null }
    },
    specialRequests: [{ type: String }],
    // §11 "Booking snapshot is immutable" / §13 "Provider Response
    // Reference" — set once at creation, never edited afterward by any
    // controller/service in this codebase (same convention as
    // FlightBookingModel.bookingSnapshot).
    bookingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ["Offer Selected", "Pending Validation", "Reserved", "Confirmed", "Modified", "Cancelled", "Completed"],
      default: "Confirmed",
      index: true
    },
    hotelName: { type: String, required: true },
    // EXT-022: relaxed from required — the real Amadeus Hotel Offers
    // response (EXT-020) this booking path books from carries no city-name
    // field at all (only a hotelId), so genuinely honest data isn't always
    // available at booking time. Left required-in-spirit for the legacy
    // hotel-distribution pipeline (which always supplies it from its own
    // search params), but a `null` here is honest, not a validation dodge.
    city: { type: String, default: null },
    stars: { type: Number, default: 5 },
    distanceToHaram: { type: String, default: null },
    roomType: { type: String, default: "Standard Room" },
    // Room view (e.g. "Haram View", "City View") — booking-module PRD Part
    // B item #9's dynamic-field list (Document 3 §28/§90), previously
    // absent from this model entirely.
    view: { type: String, default: null },
    mealPlan: { type: String, default: "Breakfast Included" },
    // Distinct from `mealPlan` (which names the plan, e.g. "Half Board") —
    // its priced value, needed for the Invoice/Voucher templates' line
    // breakdown (Document 3's sample PDFs price meals separately from room
    // rate).
    mealPrice: { type: Number, default: null },
    // Pricing season the rate was booked under (e.g. "Ramadan", "Hajj",
    // "Regular") — display-only, same convention as `cancellationPolicy`
    // being a display string.
    season: { type: String, default: null },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    roomsCount: { type: Number, default: 1 },
    guestsCount: { type: Number, default: 1 },
    guests: [
      {
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        dateOfBirth: { type: Date, default: null },
        isLeadGuest: { type: Boolean, default: false }
      }
    ],
    totalPrice: { type: Number, required: true },
    // Per-night room rate, distinct from the aggregate `totalPrice` above —
    // the Invoice/Voucher templates (Part B items #6/#7) need this to show
    // a nightly breakdown, not just the total. Not derived from
    // totalPrice/nights automatically since real per-night rates vary by
    // date (weekday/weekend, season) — left null when not supplied rather
    // than fabricating an average.
    roomRatePerNight: { type: Number, default: null },
    currency: { type: String, default: "PKR" },
    cancellationPolicy: { type: String, default: "Free cancellation up to 48 hours before check-in" },
    // EXT-024 — structured cancellation-policy data, captured once at
    // booking creation from EXT-021's real pricing verification (itself
    // derived from Amadeus's real `policies.cancellations[]`). The
    // `cancellationPolicy` string above is display-only; EXT-024's actual
    // refund/penalty computation at cancellation time needs these
    // structured fields, which previously didn't exist on this model at
    // all — a real gap found while building EXT-024, not present before.
    refundable: { type: Boolean, default: false },
    freeCancellationUntilDate: { type: Date, default: null },
    cancellationPenaltyAmount: { type: Number, default: null },
    voucherNumber: { type: String, default: null },
    voucherUrl: { type: String, default: null },
    cancellationReason: { type: String, default: null },
    cancellationPenaltyFee: { type: Number, default: null },
    cancellationRefundAmount: { type: Number, default: null },
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

HotelBookingSchema.index({ tenantId: 1, reservationNumber: 1 }, { unique: true });

export default mongoose.models.HotelBooking || mongoose.model("HotelBooking", HotelBookingSchema);
