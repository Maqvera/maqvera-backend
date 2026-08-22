import mongoose from "mongoose";

// Package Pricing Engine — PRD §5 "Hotel Engine". The core missing piece
// flagged by the trace: HotelCatalogModel/TravelHotelAssignmentModel carry
// zero rate/cost/currency fields anywhere. This model is the actual
// hotel-x-room-type-x-date rate database the legacy Excel workbooks kept in
// a flat sheet, normalized here per Golden Rules 2-3 (no hardcoded
// currency, no hardcoded room-type columns) and PRD §5's rate-basis
// priority (ExactDate > DateRange > Season > Weekend/Weekday > Standard —
// see utils/packagePricingConfig.js's hotelRateBasisPriority, applied in
// PackagePricingService.resolveHotelRate).
const HotelRateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  hotelCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "hotel_catalog",
    required: true,
    index: true
  },
  roomTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "room_type",
    required: true,
    index: true
  },
  mealPlan: { type: String, default: null },
  currency: { type: String, required: true, uppercase: true },
  pricePerNight: { type: Number, required: true, min: 0 },
  // Number of guests pricePerNight covers — the divisor for per-person cost.
  occupancy: { type: Number, required: true, min: 1 },
  // PRD §23 "Extra Bed" — an additional guest beyond `occupancy` sharing
  // the same room. `extraBedRate` left null means this rate has no extra
  // bed option at all (a segment requesting one gets a validation issue,
  // never a silently-ignored extra guest).
  extraBedRate: { type: Number, default: null, min: 0 },
  extraBedBasis: { type: String, default: null },
  maxExtraBeds: { type: Number, default: 0, min: 0 },
  rateBasis: { type: String, required: true, index: true },
  // Used when rateBasis === "ExactDate".
  date: { type: Date, default: null },
  // Used when rateBasis is DateRange/Season/Standard (open-ended standard
  // rates simply omit validTo).
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },
  // Used when rateBasis is "Weekday"/"Weekend" — 0 (Sunday) - 6 (Saturday).
  // "Weekend" isn't universally Fri-Sat (PRD §5) so this is an explicit
  // day-of-week list, not a fixed pair.
  daysOfWeek: [{ type: Number, min: 0, max: 6 }],
  season: { type: String, default: null },
  supplier: { type: String, default: null },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "package_supplier", default: null },
  contractRef: { type: String, default: null },
  receivedDate: { type: Date, default: null },
  notes: { type: String, default: null },
  documentUrl: { type: String, default: null },
  status: { type: String, required: true, index: true },
  source: { type: String, required: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

HotelRateSchema.index({ tenantId: 1, hotelCatalogId: 1, roomTypeId: 1, validFrom: 1, validTo: 1 });
HotelRateSchema.index({ tenantId: 1, hotelCatalogId: 1, roomTypeId: 1, date: 1 });
HotelRateSchema.index({ tenantId: 1, status: 1 });

HotelRateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const HotelRateModel = mongoose.model("hotel_rate", HotelRateSchema);

export default HotelRateModel;
