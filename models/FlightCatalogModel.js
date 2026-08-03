import mongoose from "mongoose";

const FlightCatalogSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  airlineCode: {
    type: String,
    required: true,
    index: true
  },
  airlineName: {
    type: String,
    required: true
  },
  flightNumber: {
    type: String,
    required: true,
    index: true
  },
  originAirport: {
    code: { type: String, required: true },
    name: { type: String, required: true },
    city: { type: String, default: null },
    country: { type: String, default: null },
    terminal: { type: String, default: null }
  },
  destinationAirport: {
    code: { type: String, required: true },
    name: { type: String, required: true },
    city: { type: String, default: null },
    country: { type: String, default: null },
    terminal: { type: String, default: null }
  },
  aircraftType: {
    type: String,
    default: "Boeing 777-300ER"
  },
  cabinClasses: [
    { type: String, enum: ["Economy", "Premium Economy", "Business", "First"] }
  ],
  durationMinutes: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, { timestamps: true });

FlightCatalogSchema.index({ tenantId: 1, airlineCode: 1, flightNumber: 1 });

const FlightCatalogModel = mongoose.model("flight_catalog", FlightCatalogSchema);

export default FlightCatalogModel;
