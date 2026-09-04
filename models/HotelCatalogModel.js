import mongoose from "mongoose";

const HotelCatalogSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  city: {
    type: String,
    required: true,
    index: true
  },
  country: {
    type: String,
    default: "Saudi Arabia"
  },
  starRating: {
    type: Number,
    min: 1,
    max: 5,
    default: 5
  },
  address: {
    type: String,
    default: null
  },
  supplier: {
    type: String,
    default: "Direct Hotel Contract"
  },
  amenities: [String],
  contacts: {
    phone: String,
    email: String,
    managerName: String
  },
  // PRD §8 "Hotel Database" — location/media/policy fields the legacy
  // catalog never carried. `latitude`/`longitude` follow the same
  // convention already used by ReferenceAirportModel/FleetResourceModel
  // rather than introducing a second lat-long-vs-URL representation.
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  distanceFromLandmark: {
    label: { type: String, default: null },
    km: { type: Number, default: null }
  },
  distanceFromAirport: { type: Number, default: null },
  checkInTime: { type: String, default: null },
  checkOutTime: { type: String, default: null },
  description: { type: String, default: null },
  images: [String],
  logoUrl: { type: String, default: null },
  shuttleAvailable: { type: Boolean, default: false },
  // Hotel-level meal plans on offer — validated against the same
  // utils/hotelConfig.js mealPlans list HotelRateModel's own per-rate
  // mealPlan free-text field already draws its values from.
  mealPlansOffered: [String],
  cancellationPolicy: { type: String, default: null },
  supplierHotelCode: { type: String, default: null },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, { timestamps: true });

HotelCatalogSchema.index({ tenantId: 1, city: 1, name: 1 });

HotelCatalogSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const HotelCatalogModel = mongoose.model("hotel_catalog", HotelCatalogSchema);

export default HotelCatalogModel;
