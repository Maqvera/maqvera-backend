import mongoose from "mongoose";

// Package Pricing Engine — PRD §82 "Reusable Package Templates". The
// separately-owed feature from choosing to delete the orphaned
// models/ServiceTemplateModel.js rather than repurpose it (that model's
// flat BookingServiceModel-shaped `includedServices[]` didn't map onto
// PackageModel's segment/transport/flight/visa/service structure anyway —
// this is a purpose-built shape instead). Segments are stored with
// day-OFFSETS from the template's own start, not absolute dates, so
// cloning against a new travelStartDate recomputes real dates.
const TemplateSegmentSchema = new mongoose.Schema({
  city: { type: String, required: true },
  country: { type: String, default: null },
  hotelCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "hotel_catalog", required: true },
  mealPlan: { type: String, default: null },
  rooms: { type: Number, default: 1, min: 1 },
  extraBeds: { type: Number, default: 0, min: 0 },
  offsetDays: { type: Number, required: true, min: 0 },
  nights: { type: Number, required: true, min: 1 },
  sortOrder: { type: Number, default: 0 }
}, { _id: true });

const PackageTemplateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  segments: { type: [TemplateSegmentSchema], default: [] },
  transportLegs: { type: mongoose.Schema.Types.Mixed, default: [] },
  flightSelections: { type: mongoose.Schema.Types.Mixed, default: [] },
  visaSelections: { type: mongoose.Schema.Types.Mixed, default: [] },
  serviceSelections: { type: mongoose.Schema.Types.Mixed, default: [] },
  vehicleSelectionRule: { type: String, default: null },
  priceListType: { type: String, default: null },
  sellingCurrency: { type: String, default: null, uppercase: true },
  markupRuleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "markup_rule" }],
  commissionRuleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "commission_rule" }],
  roundingRule: { type: String, default: null },
  discount: { type: mongoose.Schema.Types.Mixed, default: null },
  sourcePackageId: { type: mongoose.Schema.Types.ObjectId, ref: "package", default: null },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PackageTemplateSchema.index({ tenantId: 1, name: 1 });

PackageTemplateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PackageTemplateModel = mongoose.model("package_template", PackageTemplateSchema);

export default PackageTemplateModel;
