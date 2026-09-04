// Voice-Based Booking Creation PRD B7.2 — Flight is deliberately
// SEARCH-PREFILL only, never a direct booking-field extraction. Confirmed
// against models/FlightBookingModel.js: `offerId` (required), `pnr`
// (required), `providerBookingReference` (required) only ever exist after a
// real Amadeus/Sabre search + offer-select flow (AmadeusFlightSearchController/
// AmadeusFlightBookingController) — voice cannot fabricate them. This tool's
// name intentionally reads "search_prefill", not "booking_fields", so a
// caller can never mistake its output for a completed booking record.
export const FLIGHT_SEARCH_PREFILL_TOOL = {
  name: "extract_flight_search_prefill",
  description: "Extract flight SEARCH parameters (not a completed booking) from a spoken/written description, to pre-fill the flight search form. Use null for anything not genuinely present — never invent or guess a value.",
  parameters: {
    type: "object",
    properties: {
      origin: { type: ["string", "null"], description: "Origin city or airport, as spoken (not necessarily an IATA code)." },
      destination: { type: ["string", "null"] },
      departureDate: { type: ["string", "null"], description: "ISO 8601 date." },
      returnDate: { type: ["string", "null"], description: "ISO 8601 date, null if one-way." },
      passengerCount: { type: ["number", "null"] },
      passengerNames: { type: ["array", "null"], items: { type: "string" } },
      cabinClass: { type: ["string", "null"] }
    },
    required: ["origin", "destination", "departureDate", "returnDate", "passengerCount", "passengerNames", "cabinClass"]
  }
};

export const FLIGHT_SEARCH_SYSTEM_PROMPT = "You extract flight SEARCH parameters (not a completed booking — no fare, no offer, no PNR exists yet) from a spoken or written description, to pre-fill a flight search form. Call extract_flight_search_prefill exactly once. City/airport names may be given informally (e.g. 'Karachi' rather than 'KHI') — pass them through as spoken; do not attempt to resolve IATA codes yourself. Never fabricate a value for a field that isn't genuinely present — use null instead.";

/** "please verify" warnings only — never blocks. A missing returnDate is valid (one-way), so only checked when both dates are present. */
export const validateFlightSearchExtraction = (fields) => {
  const warnings = [];
  if (fields.departureDate && fields.returnDate && fields.returnDate.getTime() < fields.departureDate.getTime()) {
    warnings.push("returnDate is before departureDate — please verify.");
  }
  return warnings;
};
