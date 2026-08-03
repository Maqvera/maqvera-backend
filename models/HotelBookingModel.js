import mongoose from "mongoose";

const HotelBookingSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingHeader", index: true, default: null },
    travelPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "TravelPlan", index: true, default: null },
    offerId: { type: String, required: true },
    provider: {
      type: String,
      required: true,
      enum: ["AmadeusHotels", "Hotelbeds", "Expedia", "BookingCom", "SabreHotels", "DirectHotel"],
      default: "Hotelbeds"
    },
    reservationNumber: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["Offer Selected", "Pending Validation", "Reserved", "Confirmed", "Modified", "Cancelled", "Completed"],
      default: "Confirmed",
      index: true
    },
    hotelName: { type: String, required: true },
    city: { type: String, required: true },
    stars: { type: Number, default: 5 },
    distanceToHaram: { type: String, default: null },
    roomType: { type: String, default: "Standard Room" },
    mealPlan: { type: String, default: "Breakfast Included" },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    roomsCount: { type: Number, default: 1 },
    guestsCount: { type: Number, default: 1 },
    guests: [
      {
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        isLeadGuest: { type: Boolean, default: false }
      }
    ],
    totalPrice: { type: Number, required: true },
    currency: { type: String, default: "PKR" },
    cancellationPolicy: { type: String, default: "Free cancellation up to 48 hours before check-in" },
    voucherNumber: { type: String, default: null },
    voucherUrl: { type: String, default: null },
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

HotelBookingSchema.index({ tenantId: 1, reservationNumber: 1 }, { unique: true });

export default mongoose.models.HotelBooking || mongoose.model("HotelBooking", HotelBookingSchema);
