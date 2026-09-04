import mongoose from "mongoose";

// Car Rental as a standalone, billable booking leg (booking-module PRD Part
// B item #10). Investigated first per the PRD's own explicit instruction
// (Document 3 §36): does a "Trip/Travel Case" parent entity already exist?
// Yes — models/TravelPlanModel.js, fed from models/TravelTransportAssignmentModel.js
// — but that pattern is operational fleet/coach scheduling for GROUP
// transport (capacity defaults to 50, "Bus"/"Coaster"/"GMC" vehicle types,
// group assignedTravelers with boarding/seat status) with no pricing field
// at all, not a billable per-customer service line item. The other existing
// pattern — HotelBookingModel/FlightBookingModel, a standalone type linked
// to BookingHeaderModel via `bookingId`, with its own price/currency and a
// place in the Invoice/Voucher/Account-Statement flows — is the actual fit
// for what Document 3 describes (a rentable service with its own
// reference/price, same as Hotel/Flight). Chose to extend THIS pattern.
//
// Deliberately does NOT copy Hotel/FlightBookingModel's GDS-required fields
// (offerId/provider/PNR) — there is no real car-rental GDS adapter in this
// codebase (services/gds/ only implements Amadeus/Sabre for flights and
// hotels), and requiring those fields would mean fabricating an integration
// that doesn't exist. This models an agency-entered rental instead: real
// fields the business actually has at booking time, nothing simulated.
const CarRentalBookingSchema = new mongoose.Schema({
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
  rentalCompany: {
    type: String,
    required: true
  },
  vehicleType: {
    type: String,
    default: null
  },
  driverIncluded: {
    type: Boolean,
    default: true
  },
  pickupLocation: {
    type: String,
    required: true
  },
  dropoffLocation: {
    type: String,
    required: true
  },
  pickupDateTime: {
    type: Date,
    required: true
  },
  dropoffDateTime: {
    type: Date,
    required: true
  },
  confirmationNumber: {
    type: String,
    default: null
  },
  ratePerDay: {
    type: Number,
    default: null
  },
  totalPrice: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: "PKR"
  },
  // Multi-currency balance entry — see multi-currency-booking-and-statement-
  // requirements.md §2.4a/§7. Populated only when the rental was created
  // with an explicit convertedCurrency; null otherwise.
  convertedAmount: { type: Number, default: null },
  convertedCurrency: { type: String, default: null },
  conversionRate: { type: Number, default: null },
  conversionRateId: { type: mongoose.Schema.Types.ObjectId, ref: "exchange_rate", default: null },
  conversionAsOf: { type: Date, default: null },
  status: {
    type: String,
    enum: ["Reserved", "Confirmed", "Modified", "Cancelled", "Completed"],
    default: "Confirmed",
    index: true
  },
  cancellationPolicy: {
    type: String,
    default: null
  },
  cancelledAt: {
    type: Date,
    default: null
  },
  cancelledBy: {
    type: String,
    default: null
  },
  version: {
    type: Number,
    default: 1
  },
  versionHistory: [
    {
      version: { type: Number },
      updatedBy: { type: String },
      updatedAt: { type: Date, default: Date.now },
      changes: { type: Object }
    }
  ]
}, { timestamps: true });

CarRentalBookingSchema.index({ tenantId: 1, bookingId: 1 });

CarRentalBookingSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CarRentalBookingModel = mongoose.model("car_rental_booking", CarRentalBookingSchema);

export default CarRentalBookingModel;
