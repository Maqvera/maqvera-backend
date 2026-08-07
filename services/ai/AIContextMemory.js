import { getAIConfig } from "../../utils/aiConfig.js";

// EXT-027 "AI Agent Memory & Conversation Context" — the real gap this
// closes: AIAssistantService.chat() previously built each turn's LLM
// history from `conversation.messages.filter(m => m.role !== "tool")`,
// meaning tool RESULTS never survived past the turn they ran in. A
// follow-up like "only refundable" had no remembered origin/destination/
// dates/selected-offer to reuse — the model either re-asked the user or
// had to infer stale details from its own prior prose. This module is the
// structured layer that survives across turns instead.
//
// Every field this module writes maps to a real tool parameter or a real
// tool result this codebase actually has (see APPLIERS below) — it does
// not fabricate fields for capabilities (payment status, PNR, transport
// draft, meal-plan filtering, passenger nationality/special-assistance)
// that no tool in AIToolRegistry.js currently accepts or returns. Those
// stay present-but-null in the schema (models/AIConversationModel.js) for
// forward-compatibility, never silently populated with a guess.

const emptyContext = () => ({
  currentTopic: null, currentIntent: null, language: null,
  flight: { origin: null, destination: null, departureDate: null, returnDate: null, adults: null, cabin: null, budget: null, preferredAirline: null, selectedOfferId: null, selectedProvider: null, pricingToken: null, searchedAt: null },
  hotel: { city: null, checkIn: null, checkOut: null, guests: null, rooms: null, mealPreference: null, starRating: null, selectedHotelId: null, selectedOfferId: null, searchedAt: null },
  passengers: { adults: null, children: null, infants: null, nationality: null, passportAvailable: null, specialAssistance: null, wheelchairRequest: null, mealRequest: null },
  booking: { flightApprovalRequestId: null, hotelApprovalRequestId: null, hotelCancellationApprovalRequestId: null },
  expiresAt: null
});

// One applier per tool this module knows how to learn from — deliberately
// NOT every tool in the registry (a pure read like get_visa_requirements or
// enterprise_search has nothing that belongs in Flight/Hotel/Booking
// Context). Each applier only ever touches its own namespaced sub-object
// (flight / hotel / booking) — this is what makes EXT-027 §12 "Only
// affected context is refreshed" true by construction, not by a separate
// invalidation step.
const APPLIERS = {
  flight_search: (ctx, args) => {
    ctx.flight.origin = args.origin || ctx.flight.origin;
    ctx.flight.destination = args.destination || ctx.flight.destination;
    ctx.flight.departureDate = args.departureDate || ctx.flight.departureDate;
    ctx.flight.returnDate = args.returnDate ?? ctx.flight.returnDate;
    ctx.flight.adults = args.adults ?? ctx.flight.adults;
    ctx.flight.cabin = args.cabin || ctx.flight.cabin;
    ctx.flight.searchedAt = new Date();
    if (args.adults) { ctx.passengers.adults = args.adults; }
  },
  flight_inspiration: (ctx, args) => {
    ctx.flight.origin = args.origin || ctx.flight.origin;
    ctx.flight.departureDate = args.departureDate || ctx.flight.departureDate;
    ctx.flight.returnDate = args.returnDate ?? ctx.flight.returnDate;
    if (args.maxPrice != null) ctx.flight.budget = args.maxPrice;
    ctx.flight.searchedAt = new Date();
  },
  propose_flight_booking: (ctx, args, result) => {
    ctx.flight.selectedOfferId = args.offerId || ctx.flight.selectedOfferId;
    ctx.flight.selectedProvider = args.provider || ctx.flight.selectedProvider || "Amadeus";
    ctx.booking.flightApprovalRequestId = result?.approvalRequestId || ctx.booking.flightApprovalRequestId;
  },
  hotel_search: (ctx, args) => {
    ctx.hotel.city = args.city || ctx.hotel.city;
    ctx.hotel.checkIn = args.checkIn || ctx.hotel.checkIn;
    ctx.hotel.checkOut = args.checkOut || ctx.hotel.checkOut;
    ctx.hotel.rooms = args.rooms ?? ctx.hotel.rooms;
    ctx.hotel.guests = args.adults ?? ctx.hotel.guests;
    ctx.hotel.searchedAt = new Date();
    if (args.adults) ctx.passengers.adults = ctx.passengers.adults ?? args.adults;
  },
  search_hotel_list: (ctx, args) => {
    ctx.hotel.city = args.cityCode || ctx.hotel.city;
    if (Array.isArray(args.ratings) && args.ratings.length > 0) ctx.hotel.starRating = args.ratings[0];
    ctx.hotel.searchedAt = new Date();
  },
  get_hotel_room_offers: (ctx, args) => {
    ctx.hotel.selectedHotelId = args.hotelId || ctx.hotel.selectedHotelId;
    ctx.hotel.checkIn = args.checkInDate || ctx.hotel.checkIn;
    ctx.hotel.checkOut = args.checkOutDate || ctx.hotel.checkOut;
    ctx.hotel.rooms = args.rooms ?? ctx.hotel.rooms;
    ctx.hotel.guests = args.adults ?? ctx.hotel.guests;
    ctx.hotel.searchedAt = new Date();
  },
  verify_hotel_offer_pricing: (ctx, args) => {
    ctx.hotel.selectedOfferId = args.hotelOfferId || ctx.hotel.selectedOfferId;
  },
  propose_hotel_booking: (ctx, args, result) => {
    ctx.hotel.selectedOfferId = args.hotelOfferId || ctx.hotel.selectedOfferId;
    ctx.booking.hotelApprovalRequestId = result?.approvalRequestId || ctx.booking.hotelApprovalRequestId;
  },
  propose_hotel_cancellation: (ctx, args, result) => {
    ctx.booking.hotelCancellationApprovalRequestId = result?.approvalRequestId || ctx.booking.hotelCancellationApprovalRequestId;
  }
};

class AIContextMemory {
  static empty() {
    return emptyContext();
  }

  static sessionExpiryDate() {
    const { memorySessionTimeoutMinutes } = getAIConfig();
    return new Date(Date.now() + memorySessionTimeoutMinutes * 60 * 1000);
  }

  /**
   * Applies ONE successful tool execution's real arguments/result onto the
   * existing context, mutating only the namespaced section that tool owns.
   * Returns true if this tool is one this module tracks (so the caller
   * knows whether to bother persisting/publishing an update), false for any
   * tool with nothing here to remember (e.g. a pure lookup).
   */
  static applyToolExecution(context, toolName, args = {}, result = null) {
    const applier = APPLIERS[toolName];
    if (!applier) return false;
    if (!context.flight) Object.assign(context, emptyContext());
    applier(context, args, result);
    context.expiresAt = this.sessionExpiryDate();
    return true;
  }

  /**
   * Renders the current memory as a compact block for the system prompt —
   * EXT-027 §13 "Read Memory -> Missing Fields? -> Ask User / Call Tool".
   * Only non-null fields are included, so an empty/fresh session adds
   * nothing to the prompt at all.
   */
  static describeForPrompt(context) {
    if (!context) return null;
    const lines = [];

    const f = context.flight || {};
    const flightParts = [];
    if (f.origin || f.destination) flightParts.push(`route ${f.origin || "?"} -> ${f.destination || "?"}`);
    if (f.departureDate) flightParts.push(`departing ${f.departureDate}${f.returnDate ? ` returning ${f.returnDate}` : ""}`);
    if (f.adults) flightParts.push(`${f.adults} adult(s)`);
    if (f.cabin) flightParts.push(`cabin ${f.cabin}`);
    if (f.budget) flightParts.push(`budget ${f.budget}`);
    if (f.preferredAirline) flightParts.push(`prefers ${f.preferredAirline}`);
    if (f.selectedOfferId) flightParts.push(`already selected flight offer ${f.selectedOfferId} (${f.selectedProvider || "Amadeus"})`);
    if (flightParts.length > 0) lines.push(`Flight: ${flightParts.join(", ")}.`);

    const h = context.hotel || {};
    const hotelParts = [];
    if (h.city) hotelParts.push(`city ${h.city}`);
    if (h.checkIn) hotelParts.push(`check-in ${h.checkIn}${h.checkOut ? ` check-out ${h.checkOut}` : ""}`);
    if (h.guests) hotelParts.push(`${h.guests} guest(s)`);
    if (h.rooms) hotelParts.push(`${h.rooms} room(s)`);
    if (h.starRating) hotelParts.push(`${h.starRating}-star preference`);
    if (h.selectedHotelId) hotelParts.push(`already selected hotel ${h.selectedHotelId}`);
    if (h.selectedOfferId) hotelParts.push(`selected room offer ${h.selectedOfferId}`);
    if (hotelParts.length > 0) lines.push(`Hotel: ${hotelParts.join(", ")}.`);

    const b = context.booking || {};
    const bookingParts = [];
    if (b.flightApprovalRequestId) bookingParts.push(`flight proposal ${b.flightApprovalRequestId} pending human approval`);
    if (b.hotelApprovalRequestId) bookingParts.push(`hotel proposal ${b.hotelApprovalRequestId} pending human approval`);
    if (b.hotelCancellationApprovalRequestId) bookingParts.push(`hotel cancellation ${b.hotelCancellationApprovalRequestId} pending human approval`);
    if (bookingParts.length > 0) lines.push(`Booking: ${bookingParts.join(", ")}.`);

    if (lines.length === 0) return null;
    return lines.join("\n");
  }
}

export default AIContextMemory;
