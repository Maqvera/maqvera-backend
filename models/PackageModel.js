import mongoose from "mongoose";

// Package Pricing Engine — PRD §10 "Package Builder & Statuses" + §14
// "Recommended Database Entities". This is the entity the trace found
// completely missing: BookingHeaderModel/TravelPlanModel both carry a
// dangling `packageId` with no catalog behind it anywhere in this
// codebase. `segments[]` replaces any Makkah/Madinah-shaped fixed field —
// Umrah is just two segments of the same generic mechanism (Golden Rule
// 1). PackageSegment is deliberately embedded here rather than a separate
// top-level collection: it has no independent lifecycle or query pattern
// of its own (always read/written through its parent Package), the same
// judgment call this codebase already makes for CurrencyModel's `timeline`
// and PriceCalculationModel's `lines` — a segment that later needs
// independent querying can still be split out without touching the rest
// of this schema.
const PackageSegmentSchema = new mongoose.Schema({
  city: { type: String, required: true, trim: true },
  country: { type: String, default: null },
  hotelCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "hotel_catalog",
    required: true
  },
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  mealPlan: { type: String, default: null },
  rooms: { type: Number, default: 1, min: 1 },
  // PRD §23 "Extra Bed" — extra guests sharing this segment's room(s)
  // beyond the resolved hotel rate's own `occupancy`.
  extraBeds: { type: Number, default: 0, min: 0 },
  sortOrder: { type: Number, default: 0 }
}, { _id: true });

const TransportLegSchema = new mongoose.Schema({
  origin: { type: String, required: true, trim: true },
  destination: { type: String, required: true, trim: true },
  direction: { type: String, default: null },
  // Left null for auto-selection (PackagePricingService.selectVehicles);
  // set explicitly when vehicleSelectionRule === "Manual"/"PreferredVehicle".
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: "transport_vehicle", default: null },
  sortOrder: { type: Number, default: 0 }
}, { _id: true });

const FlightSelectionSchema = new mongoose.Schema({
  flightRateId: { type: mongoose.Schema.Types.ObjectId, ref: "flight_rate", required: true }
}, { _id: true });

const VisaSelectionSchema = new mongoose.Schema({
  visaRateId: { type: mongoose.Schema.Types.ObjectId, ref: "visa_rate", required: true }
}, { _id: true });

const ServiceSelectionSchema = new mongoose.Schema({
  serviceRateId: { type: mongoose.Schema.Types.ObjectId, ref: "service_rate", required: true },
  quantity: { type: Number, default: 1, min: 0 }
}, { _id: true });

// One row per room type the intersection of every segment's hotel actually
// has an active rate for (PRD §6) — snapshot of the last
// POST /packages/:id/calculate run, not recomputed on read.
const RoomWiseMatrixRowSchema = new mongoose.Schema({
  roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "room_type", required: true },
  roomTypeName: { type: String, required: true },
  occupancy: { type: Number, required: true },
  hotelCostPerPerson: { type: Number, required: true },
  transportCostPerPerson: { type: Number, required: true },
  flightCostPerPerson: { type: Number, required: true },
  visaCostPerPerson: { type: Number, required: true },
  servicesCostPerPerson: { type: Number, required: true },
  subtotalPerPerson: { type: Number, required: true },
  markupAmount: { type: Number, required: true },
  discountAmount: { type: Number, default: 0 },
  finalPricePerPerson: { type: Number, required: true },
  roomTotal: { type: Number, required: true },
  // Internal only — PRD §41/§50: never part of finalPricePerPerson, and
  // stripped from the controller response unless the caller holds
  // package.pricing.cost.read (same gate as the *CostPerPerson fields).
  commissionPerPerson: { type: Number, default: 0 }
}, { _id: false });

const PackageSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, default: null },
  // PRD §87 "CRM Integration" — Package <-> Customer/Booking linkage.
  // agentUserId is the selling agent (drives CommissionRuleModel's Agent
  // scope, PRD §41); neither is required — a package can be built before a
  // specific customer/agent is attached.
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customer", default: null, index: true },
  agentUserId: { type: String, default: null },
  linkedBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "booking_header", default: null },
  travelStartDate: { type: Date, required: true },
  travelEndDate: { type: Date, required: true },
  travelers: {
    adults: { type: Number, required: true, min: 1 },
    children: { type: Number, default: 0, min: 0 },
    infants: { type: Number, default: 0, min: 0 }
  },
  segments: { type: [PackageSegmentSchema], default: [] },
  transportLegs: { type: [TransportLegSchema], default: [] },
  flightSelections: { type: [FlightSelectionSchema], default: [] },
  visaSelections: { type: [VisaSelectionSchema], default: [] },
  serviceSelections: { type: [ServiceSelectionSchema], default: [] },
  vehicleSelectionRule: { type: String, required: true },
  priceListType: { type: String, required: true, index: true },
  // Net supplier cost is always in each rate's own currency; sellingCurrency
  // is the one currency every component gets converted to via
  // CurrencyService.getRate (Golden Rule 2 — never a hardcoded pair).
  sellingCurrency: { type: String, required: true, uppercase: true },
  markupRuleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "markup_rule" }],
  commissionRuleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "commission_rule" }],
  // PRD §91 "Discount Engine" — one package-level discount; Fixed+PerPerson
  // subtracts `value` straight off finalPricePerPerson, Fixed+PerRoom/
  // TotalPackage divides `value` across occupancy/totalPax first,
  // Percentage is a share of finalPricePerPerson regardless of scope (see
  // PackagePricingService.computeDiscountPerPerson's own doc comment).
  discount: {
    type: { type: String, default: null },
    value: { type: Number, default: null },
    scope: { type: String, default: null },
    reason: { type: String, default: null }
  },
  roundingRule: { type: String, required: true },
  status: { type: String, required: true, index: true },
  // PRD §51 "Package Versioning" — recalculating a locked/finalized
  // package never mutates it in place; it creates a new Package document
  // instead (PackagePricingService._calculateNewVersion) and links back
  // here, so an old quotation is never silently changed underneath a
  // customer who already received it.
  version: { type: Number, default: 1 },
  rootPackageId: { type: mongoose.Schema.Types.ObjectId, ref: "package", default: null },
  previousVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "package", default: null },
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: "package", default: null },
  // PRD §53 "Price Validity" — set on every successful calculate.
  priceValidUntil: { type: Date, default: null },
  roomWisePriceMatrix: { type: [RoomWiseMatrixRowSchema], default: [] },
  validationIssues: [{ code: String, message: String }],
  // "Locking a sent/confirmed package freezes it against later database
  // changes unless explicitly recalculated" (PRD §10) — set by
  // PackagePricingService.finalizePackage, cleared only by an explicit
  // recalculate.
  locked: { type: Boolean, default: false },
  lastCalculatedAt: { type: Date, default: null },
  finalizedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

PackageSchema.index({ tenantId: 1, status: 1 });
PackageSchema.index({ tenantId: 1, createdAt: -1 });

PackageSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PackageModel = mongoose.model("package", PackageSchema);

export default PackageModel;
