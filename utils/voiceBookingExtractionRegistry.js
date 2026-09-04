import {
  HOTEL_EXTRACTION_TOOL, HOTEL_EXTRACTION_SYSTEM_PROMPT, validateHotelExtraction, parseAIDate
} from "../services/BookingDocumentParserService.js";
import { CAR_RENTAL_EXTRACTION_TOOL, CAR_RENTAL_EXTRACTION_SYSTEM_PROMPT, validateCarRentalExtraction } from "./carRentalExtractionSchema.js";
import { FLIGHT_SEARCH_PREFILL_TOOL, FLIGHT_SEARCH_SYSTEM_PROMPT, validateFlightSearchExtraction } from "./flightSearchExtractionSchema.js";
import { getGenericServiceExtractionTool, GENERIC_SERVICE_SYSTEM_PROMPT, validateGenericServiceExtraction } from "./genericServiceExtractionSchema.js";

const numberOrNull = (v) => (typeof v === "number" ? v : null);
const stringOrNull = (v) => v || null;

// Voice-Based Booking Creation PRD B1 — the single convergence point every
// input channel (PDF/photo upload, Mode A voice-upload, Mode B live voice)
// shares: same tool schema, same system prompt, same field-mapping, same
// "flag, never block" validator, per bookingType. Adding a fifth voice-
// fillable type later means adding one entry here, not touching Mode A/B's
// own service code.
const REGISTRY = {
  hotel: {
    typeLabel: "hotel",
    tool: HOTEL_EXTRACTION_TOOL,
    systemPrompt: HOTEL_EXTRACTION_SYSTEM_PROMPT,
    fieldNames: ["guestName", "hotelName", "roomType", "checkIn", "checkOut", "pax", "ratePerNight", "total", "hotelConfirmationNumber"],
    dateFields: new Set(["checkIn", "checkOut"]),
    validate: validateHotelExtraction,
    mapFields: (raw) => ({
      guestName: stringOrNull(raw.guestName),
      hotelName: stringOrNull(raw.hotelName),
      roomType: stringOrNull(raw.roomType),
      checkIn: parseAIDate(raw.checkIn),
      checkOut: parseAIDate(raw.checkOut),
      pax: numberOrNull(raw.pax),
      ratePerNight: numberOrNull(raw.ratePerNight),
      total: numberOrNull(raw.total),
      hotelConfirmationNumber: stringOrNull(raw.hotelConfirmationNumber)
    })
  },
  car_rental: {
    typeLabel: "car rental",
    tool: CAR_RENTAL_EXTRACTION_TOOL,
    systemPrompt: CAR_RENTAL_EXTRACTION_SYSTEM_PROMPT,
    fieldNames: ["rentalCompany", "vehicleType", "pickupLocation", "dropoffLocation", "pickupDateTime", "dropoffDateTime", "confirmationNumber", "ratePerDay", "totalPrice"],
    dateFields: new Set(["pickupDateTime", "dropoffDateTime"]),
    validate: validateCarRentalExtraction,
    mapFields: (raw) => ({
      rentalCompany: stringOrNull(raw.rentalCompany),
      vehicleType: stringOrNull(raw.vehicleType),
      pickupLocation: stringOrNull(raw.pickupLocation),
      dropoffLocation: stringOrNull(raw.dropoffLocation),
      pickupDateTime: parseAIDate(raw.pickupDateTime),
      dropoffDateTime: parseAIDate(raw.dropoffDateTime),
      confirmationNumber: stringOrNull(raw.confirmationNumber),
      ratePerDay: numberOrNull(raw.ratePerDay),
      totalPrice: numberOrNull(raw.totalPrice)
    })
  },
  flight_search: {
    typeLabel: "flight search",
    tool: FLIGHT_SEARCH_PREFILL_TOOL,
    systemPrompt: FLIGHT_SEARCH_SYSTEM_PROMPT,
    fieldNames: ["origin", "destination", "departureDate", "returnDate", "passengerCount", "passengerNames", "cabinClass"],
    dateFields: new Set(["departureDate", "returnDate"]),
    validate: validateFlightSearchExtraction,
    mapFields: (raw) => ({
      origin: stringOrNull(raw.origin),
      destination: stringOrNull(raw.destination),
      departureDate: parseAIDate(raw.departureDate),
      returnDate: parseAIDate(raw.returnDate),
      passengerCount: numberOrNull(raw.passengerCount),
      passengerNames: Array.isArray(raw.passengerNames) ? raw.passengerNames : null,
      cabinClass: stringOrNull(raw.cabinClass)
    })
  },
  generic_service: {
    typeLabel: "service",
    // Built per-call (not cached at module scope) since getBookingConfig()
    // is itself env-driven and this codebase's convention is config
    // changes take effect without a restart-sensitive cached schema.
    get tool() { return getGenericServiceExtractionTool(); },
    systemPrompt: GENERIC_SERVICE_SYSTEM_PROMPT,
    get fieldNames() { return ["serviceType", "serviceName", "supplierName", "costPrice", "sellingPrice", "quantity", "startDate", "endDate", "remarks"]; },
    dateFields: new Set(["startDate", "endDate"]),
    validate: validateGenericServiceExtraction,
    mapFields: (raw) => ({
      serviceType: stringOrNull(raw.serviceType),
      serviceName: stringOrNull(raw.serviceName),
      supplierName: stringOrNull(raw.supplierName),
      costPrice: numberOrNull(raw.costPrice),
      sellingPrice: numberOrNull(raw.sellingPrice),
      quantity: numberOrNull(raw.quantity),
      startDate: parseAIDate(raw.startDate),
      endDate: parseAIDate(raw.endDate),
      remarks: stringOrNull(raw.remarks)
    })
  }
};

export const SUPPORTED_VOICE_BOOKING_TYPES = Object.keys(REGISTRY);

/** Throws a clear, catchable error for an unsupported bookingType — never silently falls back to a default schema. */
export const resolveExtractionSchema = (bookingType) => {
  const entry = REGISTRY[bookingType];
  if (!entry) {
    throw new Error(`Unsupported bookingType "${bookingType}". Must be one of: ${SUPPORTED_VOICE_BOOKING_TYPES.join(", ")}.`);
  }
  return entry;
};
