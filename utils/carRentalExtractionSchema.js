// Voice-Based Booking Creation PRD B7.1 — Car Rental direct-fill schema.
// Same shape/discipline as BookingDocumentParserService.js's
// HOTEL_EXTRACTION_TOOL (null for anything not genuinely present/said,
// never a fabricated value), field names matching CarRentalBookingModel.js
// exactly (rentalCompany/vehicleType/pickupLocation/dropoffLocation/
// pickupDateTime/dropoffDateTime/confirmationNumber/ratePerDay/totalPrice —
// confirmed against the real model before writing this).
export const CAR_RENTAL_EXTRACTION_TOOL = {
  name: "extract_car_rental_booking_fields",
  description: "Extract structured car rental booking fields from a spoken/written description. Use null for anything not genuinely present — never invent or guess a value.",
  parameters: {
    type: "object",
    properties: {
      rentalCompany: { type: ["string", "null"] },
      vehicleType: { type: ["string", "null"] },
      pickupLocation: { type: ["string", "null"] },
      dropoffLocation: { type: ["string", "null"] },
      pickupDateTime: { type: ["string", "null"], description: "ISO 8601 datetime." },
      dropoffDateTime: { type: ["string", "null"], description: "ISO 8601 datetime." },
      confirmationNumber: { type: ["string", "null"] },
      ratePerDay: { type: ["number", "null"] },
      totalPrice: { type: ["number", "null"] }
    },
    required: ["rentalCompany", "vehicleType", "pickupLocation", "dropoffLocation", "pickupDateTime", "dropoffDateTime", "confirmationNumber", "ratePerDay", "totalPrice"]
  }
};

export const CAR_RENTAL_EXTRACTION_SYSTEM_PROMPT = "You extract structured car rental booking fields from a spoken or written description for a travel agency's booking system. Call extract_car_rental_booking_fields exactly once with your best-effort reading. Never fabricate a value for a field that isn't genuinely present — use null instead.";

/** "please verify" warnings only — same never-block discipline as BookingDocumentParserService's validateHotelExtraction. Pure, no DB/I/O. */
export const validateCarRentalExtraction = (fields) => {
  const warnings = [];
  if (fields.pickupDateTime && fields.dropoffDateTime && fields.dropoffDateTime.getTime() <= fields.pickupDateTime.getTime()) {
    warnings.push("dropoffDateTime is not after pickupDateTime — please verify.");
  }
  return warnings;
};
