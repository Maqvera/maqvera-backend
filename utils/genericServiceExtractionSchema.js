import { getBookingConfig } from "./bookingConfig.js";

// Voice-Based Booking Creation PRD B7.3 — generic direct-fill schema for
// every BookingServiceModel.serviceType that has no dedicated rich model
// (visa, transport, insurance, guide, meals, meal_plan, ziyarat, activity,
// addon, package, room, other). Field names match AddBookingServices'
// existing accepted request body exactly (controllers/BookingController.js
// serviceInputs destructure) — this feeds an endpoint that already exists,
// no new booking-creation logic needed.
//
// The `serviceType` enum is built at call time from getBookingConfig()
// (utils/bookingConfig.js's env-overridable BOOKING_SERVICE_TYPES_JSON,
// the same config middleware/validateRequest.js's addBookingServices Joi
// schema itself pulls from) rather than a hardcoded array — config-driven,
// per this codebase's own established convention (CLAUDE.md "Config-driven
// domain values"). "flight"/"hotel" are excluded since those get their own
// dedicated tools (FLIGHT_SEARCH_PREFILL_TOOL / HOTEL_EXTRACTION_TOOL).
export const getGenericServiceExtractionTool = () => {
  const serviceTypeValues = getBookingConfig().serviceTypes.filter((t) => t !== "hotel" && t !== "flight");
  return {
    name: "extract_generic_service_fields",
    description: "Extract structured booking-service fields from a spoken/written description, for service types without a dedicated rich schema. Use null for anything not genuinely present — never invent or guess a value.",
    parameters: {
      type: "object",
      properties: {
        serviceType: { type: "string", enum: serviceTypeValues },
        serviceName: { type: ["string", "null"] },
        supplierName: { type: ["string", "null"] },
        costPrice: { type: ["number", "null"] },
        sellingPrice: { type: ["number", "null"] },
        quantity: { type: ["number", "null"] },
        startDate: { type: ["string", "null"], description: "ISO 8601 date." },
        endDate: { type: ["string", "null"], description: "ISO 8601 date." },
        remarks: { type: ["string", "null"] }
      },
      required: ["serviceType", "serviceName", "supplierName", "costPrice", "sellingPrice", "quantity", "startDate", "endDate", "remarks"]
    }
  };
};

export const GENERIC_SERVICE_SYSTEM_PROMPT = "You extract structured booking-service fields from a spoken or written description for a travel agency's booking system (visa, transport, insurance, guide, meals, ziyarat, activity, and similar ancillary services). Call extract_generic_service_fields exactly once. serviceType must be exactly one of the enum values given to you. Never fabricate a value for a field that isn't genuinely present — use null instead.";

/** "please verify" warnings only — never blocks. */
export const validateGenericServiceExtraction = (fields) => {
  const warnings = [];
  if (fields.startDate && fields.endDate && fields.endDate.getTime() < fields.startDate.getTime()) {
    warnings.push("endDate is before startDate — please verify.");
  }
  return warnings;
};
