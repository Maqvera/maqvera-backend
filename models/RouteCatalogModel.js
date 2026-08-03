import mongoose from "mongoose";

const RouteCatalogSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  routeName: {
    type: String,
    required: true,
    index: true
  },
  origin: {
    type: String,
    required: true
  },
  destination: {
    type: String,
    required: true
  },
  stops: [
    {
      stopName: String,
      stopLocation: String,
      durationMinutes: Number
    }
  ],
  estimatedDistanceKm: {
    type: Number,
    default: 0
  },
  estimatedDurationMinutes: {
    type: Number,
    default: 0
  },
  preferredRoute: {
    type: String,
    default: null
  },
  alternativeRoute: {
    type: String,
    default: null
  },
  // "Route Includes" (Part 5) also names Road Restrictions and GPS
  // Coordinates — both existed in the doc's spec but not on this
  // already-existing model, added here since this Part is the first to
  // actually wire RouteCatalogModel into real usage.
  roadRestrictions: [String],
  gpsCoordinates: {
    origin: { latitude: { type: Number, default: null }, longitude: { type: Number, default: null } },
    destination: { latitude: { type: Number, default: null }, longitude: { type: Number, default: null } }
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, { timestamps: true });

RouteCatalogSchema.index({ tenantId: 1, origin: 1, destination: 1 });

const RouteCatalogModel = mongoose.model("route_catalog", RouteCatalogSchema);

export default RouteCatalogModel;
