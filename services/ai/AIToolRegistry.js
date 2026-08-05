import GdsIntegrationService from "../GdsIntegrationService.js";
import AmadeusFlightScheduleService from "../AmadeusFlightScheduleService.js";
import ReferenceDataService from "../ReferenceDataService.js";
import AmadeusFlightInspirationService from "../AmadeusFlightInspirationService.js";
import AmadeusFlightBrandedFaresService from "../AmadeusFlightBrandedFaresService.js";
import AmadeusAncillaryServicesService from "../AmadeusAncillaryServicesService.js";
import FlightScheduleSyncService from "../FlightScheduleSyncService.js";
import AmadeusHotelSearchService from "../AmadeusHotelSearchService.js";
import AmadeusHotelOfferService from "../AmadeusHotelOfferService.js";
import AmadeusHotelPricingService from "../AmadeusHotelPricingService.js";
import AmadeusHotelBookingRetrievalService from "../AmadeusHotelBookingRetrievalService.js";
import AIToolRateLimiter from "./AIToolRateLimiter.js";
import VisaRequirementService from "../VisaRequirementService.js";
import EnterpriseIncidentEngineService from "../EnterpriseIncidentEngineService.js";
import VisaAnalyticsEngine from "../VisaAnalyticsEngine.js";
import SearchEngineService from "../SearchEngineService.js";
import BookingHeaderModel from "../../models/BookingHeaderModel.js";
import TravelPlanModel from "../../models/TravelPlanModel.js";
import AIApprovalRequestModel from "../../models/AIApprovalRequestModel.js";
import { publishEvent } from "../../utils/eventBus.js";
import { getAIConfig } from "../../utils/aiConfig.js";

const MANAGEMENT_ROLES = new Set(["administrator", "admin", "manager", "management", "director", "executive", "finance", "compliance"]);

const hasPermission = (permissions, required) => required.some((p) => permissions.includes(p)) || permissions.includes("admin");

const defaultRetryPolicy = () => {
  const { toolDefaultMaxRetries } = getAIConfig();
  return { retryable: true, maxRetries: toolDefaultMaxRetries };
};

/**
 * AI Tool Registry — "Read Models Only", "Tool Calling", "Human Approval
 * Required", "Tool Registry Pattern" (API-006G §6: every tool declares
 * Name/Description/Input Schema/Output Schema/Permissions/Roles/Execution
 * Type/Timeout/Retry Policy/Provider/Version/Owner Module).
 *
 * This is the real guardrail behind "AI never books flights, cancels
 * tickets, issues refunds...": every tool here is either a pure read, or —
 * for the one deliberately-scoped exception below — a "propose" action
 * that only ever creates a pending AIApprovalRequestModel row and hands
 * back the real REST endpoint call a human must make; it never performs
 * the write itself. No tool in this file calls a booking/cancel/refund
 * service method directly.
 */
const TOOLS = [
  {
    name: "flight_search",
    description: "Search live flight availability between two airports for given dates and passenger counts. Use for any flight-related question.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "3-letter IATA origin airport code" },
        destination: { type: "string", description: "3-letter IATA destination airport code" },
        departureDate: { type: "string", description: "YYYY-MM-DD" },
        returnDate: { type: "string", description: "YYYY-MM-DD, only for round-trip" },
        tripType: { type: "string", enum: ["OneWay", "RoundTrip"] },
        adults: { type: "integer", minimum: 1 },
        cabin: { type: "string", enum: ["Economy", "PremiumEconomy", "Business", "First"] }
      },
      required: ["origin", "destination", "departureDate"]
    },
    outputSchema: { type: "object", description: "{ provider, totalOffers, offers: [{ offerId, airline, price, ... }] }" },
    requiredPermissions: ["flight.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await GdsIntegrationService.searchFlights({
        tenantId: context.tenantId,
        correlationId: context.conversationId || context.executionId,
        tripType: args.tripType || "OneWay",
        origin: String(args.origin || "").toUpperCase(),
        destination: String(args.destination || "").toUpperCase(),
        departureDate: args.departureDate,
        returnDate: args.returnDate,
        adults: args.adults || 1,
        cabin: args.cabin || "Economy",
        currency: args.currency || "PKR"
      });
      return { provider: result.provider, totalOffers: result.meta.totalOffers, offers: result.results.slice(0, 10) };
    }
  },
  {
    name: "hotel_search",
    description: "Search live hotel availability in a city for given check-in/check-out dates and guest counts.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
        checkIn: { type: "string", description: "YYYY-MM-DD" },
        checkOut: { type: "string", description: "YYYY-MM-DD" },
        rooms: { type: "integer", minimum: 1 },
        adults: { type: "integer", minimum: 1 }
      },
      required: ["city", "checkIn", "checkOut"]
    },
    outputSchema: { type: "object", description: "{ provider, totalOffers, offers: [{ offerId, hotelName, price, ... }] }" },
    requiredPermissions: ["hotel.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await GdsIntegrationService.searchHotels({
        tenantId: context.tenantId,
        city: args.city,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        rooms: args.rooms || 1,
        adults: args.adults || 2,
        currency: args.currency || "PKR"
      });
      return { provider: result.provider, totalOffers: result.meta.totalOffers, offers: result.results.slice(0, 10) };
    }
  },
  {
    name: "flight_schedule",
    description: "Retrieve planned (unpriced) flight schedules between two airports for a future date, for planning/itinerary support — not for booking. Returns AI-ready insights (shortest, least-stop, overnight, business-friendly options).",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "3-letter IATA origin airport code" },
        destination: { type: "string", description: "3-letter IATA destination airport code" },
        departureDate: { type: "string", description: "YYYY-MM-DD" },
        airlineCode: { type: "string", description: "Optional 2-letter IATA airline code to filter by" },
        nonStop: { type: "boolean", description: "Only return non-stop schedules" }
      },
      required: ["origin", "destination", "departureDate"]
    },
    outputSchema: { type: "object", description: "{ origin, destination, departureDate, schedules: [...], insights: { shortestFlightNumber, leastStopsFlightNumber, overnightFlightNumbers, businessFriendlyFlightNumbers, airlinesCompared } }" },
    requiredPermissions: ["travel.flight.schedule.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      publishEvent("PlanningStarted", { tenantId: context.tenantId, origin: args.origin, destination: args.destination, departureDate: args.departureDate });
      const result = await AmadeusFlightScheduleService.getSchedules({
        tenantId: context.tenantId,
        userId: context.userId,
        origin: String(args.origin || "").toUpperCase(),
        destination: String(args.destination || "").toUpperCase(),
        departureDate: args.departureDate,
        airlineCode: args.airlineCode,
        nonStop: args.nonStop,
        maxResults: 10,
        requestId: context.conversationId || context.executionId
      });
      publishEvent("AIRecommendationGenerated", { tenantId: context.tenantId, origin: args.origin, destination: args.destination, insights: result.insights });
      return result;
    }
  },
  {
    name: "flight_inspiration",
    description: "Discover destinations from an origin airport within a budget/period, when the traveler doesn't have a fixed destination yet — e.g. 'cheapest destinations from Karachi', 'best weekend trips under my budget', 'Umrah options next week'. This is the ONLY way this AI Assistant reaches Amadeus's Flight Inspiration data — it calls the same internal service the REST endpoint calls, never the Amadeus adapter directly.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "3-letter IATA origin airport code" },
        departureDate: { type: "string", description: "YYYY-MM-DD, optional" },
        returnDate: { type: "string", description: "YYYY-MM-DD, optional — round trip" },
        maxPrice: { type: "number", description: "Positive budget ceiling, optional" },
        nonStop: { type: "boolean", description: "Only non-stop destinations, optional" }
      },
      required: ["origin"]
    },
    outputSchema: { type: "object", description: "{ origin, results: [{ destination, city, country, lowestPrice, currency, departureDate, returnDate, nonStop }], meta }. Ranked by price, then trip length, then non-stop preference (§15) — never re-ranked by the AI itself, since airline/historical-preference data isn't available from this endpoint and is honestly omitted rather than guessed." },
    requiredPermissions: ["travel.flight.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await AmadeusFlightInspirationService.getInspiration({
        tenantId: context.tenantId, userId: context.userId,
        origin: String(args.origin || "").toUpperCase(), departureDate: args.departureDate, returnDate: args.returnDate,
        maxPrice: args.maxPrice, nonStop: args.nonStop, maxResults: 10
      });
      publishEvent("AIRecommendationGenerated", { tenantId: context.tenantId, origin: result.origin, resultCount: result.results.length });
      return result;
    }
  },
  {
    name: "compare_branded_fares",
    description: "Retrieve and compare all fare-brand options (Economy Basic/Flex, Business Saver/Flex, etc.) for a flight offer the traveler already selected from a prior flight_search call — baggage, refund/date-change policy where known, seat selection, priority boarding, lounge access, meal inclusion. Use this to explain fare differences and recommend the best-value option (e.g. for a group of Umrah travelers, a family, or a business traveler) — reason over the real fares/comparison data returned here, never invent airline pricing or policy.",
    parameters: {
      type: "object",
      properties: {
        flightOfferId: { type: "string", description: "offerId from a prior flight_search result" },
        currency: { type: "string", description: "Informational only — Amadeus's real Upselling API has no currency override; the response reports the offer's own actual currency" }
      },
      required: ["flightOfferId"]
    },
    outputSchema: { type: "object", description: "{ flightOfferId, fares: [{ fareName, cabin, price, currency, checkedBaggage, carryOn, seatSelection, refund, dateChange, priorityBoarding, loungeAccess, mealIncluded, milesEligible, upgradeEligible }], comparison: { cheapestFare, mostFlexibleFare } }. `refund`/`dateChange`/`carryOn`/`milesEligible` are `null` when Amadeus's real response has no confirmed data for them — never guessed." },
    requiredPermissions: ["travel.flight.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await AmadeusFlightBrandedFaresService.getBrandedFares({
        tenantId: context.tenantId, userId: context.userId, flightOfferId: args.flightOfferId, currency: args.currency, requestId: context.conversationId || context.executionId
      });
      return { flightOfferId: result.flightOfferId, fares: result.fares, comparison: result.comparison };
    }
  },
  {
    name: "recommend_ancillary_services",
    description: "Retrieve the priced optional add-on services (extra baggage, meals, lounge access, priority boarding, extra legroom, etc.) available for a flight offer/fare the traveler already selected. Use this to recommend baggage/meal/lounge options for specific traveler groups (e.g. Umrah groups with heavy luggage, elderly travelers, families) and to explain their cost — reason over the real priced services returned here. This tool NEVER purchases anything; it only retrieves and helps compare options.",
    parameters: {
      type: "object",
      properties: {
        flightOfferId: { type: "string", description: "offerId from a prior flight_search result" },
        currency: { type: "string", description: "Informational only" },
        passengers: { type: "integer", description: "Optional — must not exceed the offer's own passenger count" }
      },
      required: ["flightOfferId"]
    },
    outputSchema: { type: "object", description: "{ flightOfferId, services: [{ serviceId, category, description, price, currency, perPassenger }] }. An empty services array is a normal outcome — ancillary availability is airline/fare-dependent, never fabricated when genuinely unavailable." },
    requiredPermissions: ["travel.flight.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await AmadeusAncillaryServicesService.getAncillaries({
        tenantId: context.tenantId, userId: context.userId, flightOfferId: args.flightOfferId, currency: args.currency, passengers: args.passengers, requestId: context.conversationId || context.executionId
      });
      return { flightOfferId: result.flightOfferId, services: result.services };
    }
  },
  {
    name: "trigger_flight_schedule_sync",
    description: "On-demand refresh of the tenant's active ticketed flights against live Amadeus status (the same sync the background scheduler runs automatically). Use when a traveler/employee asks for the freshest possible flight status before making a recommendation. Returns only a count summary (synced/failed/skipped) — this tool never changes bookings, pricing, or passenger data, and any onward itinerary/hotel/transport recommendation still requires a human to approve before anything is changed (§19).",
    parameters: {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["standard", "high"], description: "Which priority tier to sync; defaults to standard" }
      },
      required: []
    },
    outputSchema: { type: "object", description: "{ synced, failed, skipped, total }" },
    requiredPermissions: ["travel.flight.sync.trigger"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await FlightScheduleSyncService.syncTenant({ tenantId: context.tenantId, tier: args.tier === "high" ? "high" : "standard" });
      return result;
    }
  },
  {
    name: "search_hotel_list",
    description: "Discover real hotels in a city or near a geographic point via live Amadeus inventory (name, location, chain, distance) — for 'suggest hotels in Jeddah near Haram'-style requests. Distinct from the existing 'hotel_search' tool, which searches priced availability for specific check-in/check-out dates; this is discovery-only (§21 'Hotel Search only discovers hotels' — no price, no room type, no rating is fabricated here since Amadeus's real Hotel List response doesn't include them).",
    parameters: {
      type: "object",
      properties: {
        cityCode: { type: "string", description: "3-letter IATA city code, e.g. JED" },
        latitude: { type: "number", description: "Alternative to cityCode — requires longitude too" },
        longitude: { type: "number" },
        radius: { type: "number", description: "Search radius around latitude/longitude" },
        hotelName: { type: "string", description: "Filter by partial hotel name" },
        chainCode: { type: "string", description: "Filter by 2-letter Amadeus hotel chain code" },
        ratings: { type: "array", items: { type: "integer", minimum: 1, maximum: 5 }, description: "Filter by star rating(s) — real Amadeus filter, but note: the response itself doesn't echo rating per hotel" }
      },
      required: []
    },
    outputSchema: { type: "object", description: "{ hotels: [{ hotelId, hotelName, city, country, latitude, longitude, chainCode, chain, distance, rating, amenities }] }. `rating`/`amenities`/`chain` are null/empty on live results — genuinely not part of Amadeus's real Hotel List response; use the (upcoming) hotel offers/pricing capability for those." },
    requiredPermissions: ["travel.hotel.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await AmadeusHotelSearchService.getHotels({
        tenantId: context.tenantId, userId: context.userId,
        cityCode: args.cityCode, latitude: args.latitude, longitude: args.longitude, radius: args.radius,
        hotelName: args.hotelName, chainCode: args.chainCode, ratings: args.ratings, pageSize: 20
      });
      publishEvent("HotelRecommendationGenerated", { tenantId: context.tenantId, cityCode: args.cityCode || null, resultCount: result.hotels.length });
      return { hotels: result.hotels };
    }
  },
  {
    name: "get_hotel_room_offers",
    description: "Retrieve live, priced room offers (room type, meal plan, occupancy, refund/cancellation policy) for a hotel the traveler already selected from a prior search_hotel_list result. Use to recommend the best-value room for a family/Umrah group/business traveler, compare meal plans, explain cancellation policies, or estimate total stay cost — reason over the real offers returned here. This tool NEVER books a room.",
    parameters: {
      type: "object",
      properties: {
        hotelId: { type: "string", description: "hotelId from a prior search_hotel_list result" },
        checkInDate: { type: "string", description: "YYYY-MM-DD" },
        checkOutDate: { type: "string", description: "YYYY-MM-DD" },
        adults: { type: "integer", minimum: 1 },
        rooms: { type: "integer", minimum: 1 },
        currency: { type: "string" }
      },
      required: ["hotelId", "checkInDate", "checkOutDate"]
    },
    outputSchema: { type: "object", description: "{ hotelId, hotel: { rating, amenities }, offers: [{ offerId, roomType, bedType, occupancy, mealPlan, price, taxesAndFees, currency, refundable, freeCancellationUntil }] }. `availableRooms` is always null — Amadeus's real Hotel Offers response prices individual bookable offers, it doesn't expose remaining room-count inventory." },
    requiredPermissions: ["travel.hotel.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const result = await AmadeusHotelOfferService.getOffers({
        tenantId: context.tenantId, userId: context.userId,
        hotelId: args.hotelId, checkInDate: args.checkInDate, checkOutDate: args.checkOutDate,
        adults: args.adults, rooms: args.rooms, currency: args.currency
      });
      publishEvent("RoomRecommendationGenerated", { tenantId: context.tenantId, hotelId: result.hotelId, offerCount: result.offers.length });
      return { hotelId: result.hotelId, hotel: result.hotel, offers: result.offers };
    }
  },
  {
    name: "verify_hotel_offer_pricing",
    description: "Re-verify the live price and availability of a specific hotel room offer immediately before booking (hotel inventory/pricing changes constantly — a room seen minutes ago may already be gone or repriced). Use this to explain a price increase/decrease, confirm a room is still bookable, or recommend an alternative when it's no longer available. This tool NEVER books anything or modifies provider pricing — it only reads and compares.",
    parameters: {
      type: "object",
      properties: {
        hotelOfferId: { type: "string", description: "offerId from a prior get_hotel_room_offers result" },
        currency: { type: "string" }
      },
      required: ["hotelOfferId"]
    },
    outputSchema: { type: "object", description: "{ hotelOfferId, status, price, currency, taxes, fees, total, available, refundable, freeCancellationUntil, meta: { priceChanged, previousTotal } }. `fees` is null — Amadeus's real response doesn't reliably separate 'fee' from 'tax' as distinct categories; the real combined tax total is reported under `taxes` instead of a guessed split." },
    requiredPermissions: ["travel.hotel.book"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      return AmadeusHotelPricingService.verifyPricing({ tenantId: context.tenantId, userId: context.userId, hotelOfferId: args.hotelOfferId, currency: args.currency });
    }
  },
  {
    name: "get_hotel_booking_details",
    description: "Retrieve/summarize an existing confirmed hotel reservation by its provider confirmation number (e.g. for 'show my latest hotel booking' or explaining a reservation's status/room/meal plan). Read-only — this tool NEVER modifies a reservation.",
    parameters: {
      type: "object",
      properties: {
        providerBookingId: { type: "string", description: "e.g. AMD-HOTEL-9834521" }
      },
      required: ["providerBookingId"]
    },
    outputSchema: { type: "object", description: "{ bookingId, providerBookingId, status, hotelName, roomType, checkIn, checkOut, guests, mealPlan, confirmationNumber }" },
    requiredPermissions: ["travel.hotel.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      return AmadeusHotelBookingRetrievalService.getBooking({ tenantId: context.tenantId, userId: context.userId, providerBookingId: args.providerBookingId });
    }
  },
  {
    name: "reference_data_lookup",
    description: "Look up standardized aviation reference data (airports, airlines, aircraft types, countries, cities) from the platform's synchronized master data — never a live external call. Use to explain airport/airline codes, convert a city name into its airport codes, explain an aircraft type, compute the UTC offset difference between two airports, or (type=airport_search) fuzzy/typo-tolerant search a free-text airport/city name — e.g. 'Karachy' or 'I want to fly from Karachi'.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["airport", "airline", "aircraft", "country", "city", "timezone_diff", "airport_search"] },
        code: { type: "string", description: "Exact IATA code to look up (airport/airline/aircraft/country/city)" },
        city: { type: "string", description: "City name — for type=airport, converts a city name into its airport codes" },
        country: { type: "string", description: "Country name — for type=airport/city filters" },
        originCode: { type: "string", description: "For type=timezone_diff: origin airport IATA code" },
        destinationCode: { type: "string", description: "For type=timezone_diff: destination airport IATA code" },
        query: { type: "string", description: "For type=airport_search: free-text, typo-tolerant search term (min 2 characters), e.g. a city or airport name as the user typed it" }
      },
      required: ["type"]
    },
    outputSchema: { type: "object", description: "{ items: [...] } for lookup types; { originOffset, destinationOffset, differenceMinutes } for timezone_diff (null fields mean the data genuinely isn't known, never guessed); { results: [...], ambiguous } for airport_search — 'ambiguous' is true when multiple distinct cities score within 5 points of the top result (§16 'Detect ambiguous airport searches')." },
    requiredPermissions: ["reference.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "ReferenceData",
    handler: async (args, context) => {
      const parseOffsetMinutes = (offset) => {
        const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset || ""));
        if (!match) return null;
        const sign = match[1] === "-" ? -1 : 1;
        return sign * (Number.parseInt(match[2], 10) * 60 + Number.parseInt(match[3], 10));
      };

      switch (args.type) {
        case "airport": {
          const result = await ReferenceDataService.getAirports({ code: args.code, city: args.city, country: args.country, limit: 10 });
          return { items: result.items };
        }
        case "airline": {
          const result = await ReferenceDataService.getAirlines({ code: args.code, limit: 10 });
          return { items: result.items };
        }
        case "aircraft": {
          const result = await ReferenceDataService.getAircraft({ code: args.code, limit: 10 });
          return { items: result.items };
        }
        case "country": {
          const result = await ReferenceDataService.getCountries({ code: args.code, limit: 10 });
          return { items: result.items };
        }
        case "city": {
          const result = await ReferenceDataService.getCities({ code: args.code, country: args.country, limit: 10 });
          return { items: result.items };
        }
        case "timezone_diff": {
          const [origin] = (await ReferenceDataService.getAirports({ code: args.originCode, limit: 1 })).items;
          const [destination] = (await ReferenceDataService.getAirports({ code: args.destinationCode, limit: 1 })).items;
          const originOffset = parseOffsetMinutes(origin?.timezone);
          const destinationOffset = parseOffsetMinutes(destination?.timezone);
          return {
            originOffset: origin?.timezone || null,
            destinationOffset: destination?.timezone || null,
            differenceMinutes: originOffset != null && destinationOffset != null ? destinationOffset - originOffset : null
          };
        }
        case "airport_search": {
          const result = await ReferenceDataService.searchAirports({ tenantId: context.tenantId, userId: context.userId, q: args.query, limit: 10 });
          const distinctCities = new Set(result.results.slice(0, 3).map((r) => r.city));
          const topScore = result.results[0]?.score ?? 0;
          const ambiguous = distinctCities.size > 1 && result.results.slice(1, 3).some((r) => topScore - r.score <= 5);
          return { results: result.results, ambiguous };
        }
        default:
          return { error: `Unknown lookup type "${args.type}".` };
      }
    }
  },
  {
    name: "explain_fare_rules",
    description: "Retrieve cancellation/change fee rules for a specific flight offer ID (obtained from a prior flight_search call).",
    parameters: {
      type: "object",
      properties: { offerId: { type: "string" }, provider: { type: "string" } },
      required: ["offerId"]
    },
    outputSchema: { type: "object", description: "{ provider, offerId, rules: { cancellationFeeBeforeDeparture, changeFee, ... } }" },
    requiredPermissions: ["flight.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args) => GdsIntegrationService.getFareRules({ offerId: args.offerId, provider: args.provider || "Amadeus" })
  },
  {
    name: "get_visa_requirements",
    description: "Get visa requirement profiles (documents, processing days, fees) for a destination country, optionally filtered by visa type or nationality.",
    parameters: {
      type: "object",
      properties: {
        destinationCountry: { type: "string" },
        visaType: { type: "string" },
        nationality: { type: "string" }
      },
      required: ["destinationCountry"]
    },
    outputSchema: { type: "object", description: "Requirement profile(s) for the destination country." },
    requiredPermissions: ["visa.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "Visa",
    handler: async (args, context) => VisaRequirementService.getRequirementProfilesForCountry(null, {
      destinationCountry: args.destinationCountry,
      visaType: args.visaType,
      nationality: args.nationality
    }, context.tenantId)
  },
  {
    name: "get_booking_status",
    description: "Look up the status of an existing booking by its booking number.",
    parameters: {
      type: "object",
      properties: { bookingNumber: { type: "string" } },
      required: ["bookingNumber"]
    },
    outputSchema: { type: "object", description: "{ found, booking: { bookingNumber, status, paymentStatus, ... } }" },
    requiredPermissions: ["bookings.read", "booking.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "Booking",
    handler: async (args, context) => {
      const booking = await BookingHeaderModel.findOne({ bookingNumber: args.bookingNumber, tenantId: context.tenantId })
        .select("bookingNumber status bookingType paymentStatus totalAmount paidAmount createdAt")
        .lean();
      if (!booking) return { found: false, message: "No booking found with that booking number for this tenant." };
      return { found: true, booking };
    }
  },
  {
    name: "get_travel_plan_status",
    description: "Look up the on-the-ground travel operations progress of a travel plan by its travel plan number.",
    parameters: {
      type: "object",
      properties: { travelPlanNumber: { type: "string" } },
      required: ["travelPlanNumber"]
    },
    outputSchema: { type: "object", description: "{ found, plan: { travelPlanNumber, status, travelType, ... } }" },
    requiredPermissions: ["travel.read", "travel_plans.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "TravelOperations",
    handler: async (args, context) => {
      const plan = await TravelPlanModel.findOne({ travelPlanNumber: args.travelPlanNumber, tenantId: context.tenantId })
        .select("travelPlanNumber status travelType coordinator createdAt")
        .lean();
      if (!plan) return { found: false, message: "No travel plan found with that number for this tenant." };
      return { found: true, plan };
    }
  },
  {
    name: "get_operations_dashboard",
    description: "Get today's operational Visa dashboard summary (queue, pending documents, appointments, open incidents).",
    parameters: { type: "object", properties: {} },
    outputSchema: { type: "object", description: "Operations dashboard summary object." },
    requiredPermissions: ["visa.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "Analytics",
    handler: async (args, context) => {
      const result = await VisaAnalyticsEngine.operationsDashboard({ tenantId: context.tenantId, branchId: context.branchId || "main" });
      return result.data;
    }
  },
  {
    name: "get_revenue_dashboard",
    description: "Get revenue/finance KPIs. Only available to management-tier roles (executive, finance, director, manager, admin).",
    parameters: { type: "object", properties: {} },
    outputSchema: { type: "object", description: "Finance dashboard summary object, or { denied: true } if the caller's role isn't management-tier." },
    requiredPermissions: ["visa.read"],
    requiredRoles: [...MANAGEMENT_ROLES],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "Analytics",
    handler: async (args, context) => {
      const role = (context.role || "").toLowerCase();
      if (!MANAGEMENT_ROLES.has(role) && !context.permissions.includes("admin")) {
        return { denied: true, message: "This user's role does not have access to financial dashboards." };
      }
      const result = await VisaAnalyticsEngine.financeDashboard({ tenantId: context.tenantId, branchId: context.branchId || "main" });
      return result.data;
    }
  },
  {
    name: "get_incidents_summary",
    description: "Get a summary of recent operational incidents, optionally filtered by severity or status.",
    parameters: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["Low", "Medium", "High", "Critical", "Emergency"] },
        status: { type: "string" }
      }
    },
    outputSchema: { type: "object", description: "{ items: [...], pagination: {...} }" },
    requiredPermissions: ["incidents.read"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "Incidents",
    handler: async (args, context) => EnterpriseIncidentEngineService.getIncidents({ severity: args.severity, status: args.status, pageSize: 10 }, context.tenantId)
  },
  {
    name: "enterprise_search",
    description: "Full-text search across all business entities (visa cases, travelers, passports, documents, bookings, etc.) when the user's question doesn't match a more specific tool.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    },
    outputSchema: { type: "object", description: "{ totalItems, results: [...] }" },
    requiredPermissions: [],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "read",
    requiresApproval: false,
    version: "1.0.0",
    ownerModule: "Search",
    handler: async (args, context) => {
      // SearchEngineService already filters results by the caller's real
      // permissions internally — no additional gate needed here.
      const result = await SearchEngineService.globalSearch({
        tenantId: context.tenantId, query: args.query, branchId: context.branchId, permissions: context.permissions, pageSize: 10
      });
      return { totalItems: result.meta.totalItems, results: result.results };
    }
  },
  {
    name: "propose_flight_booking",
    description: "Propose booking a specific flight offer (obtained from a prior flight_search call) for one traveler. This NEVER creates a real reservation — it only creates a pending approval request. A human with the required role must explicitly approve it via POST /api/v1/ai/tools/approval before any booking happens.",
    parameters: {
      type: "object",
      properties: {
        offerId: { type: "string" },
        provider: { type: "string" },
        travelerFirstName: { type: "string" },
        travelerLastName: { type: "string" },
        passportNumber: { type: "string" }
      },
      required: ["offerId", "travelerFirstName", "travelerLastName", "passportNumber"]
    },
    outputSchema: { type: "object", description: "{ approvalRequestId, status: 'pending', message }" },
    requiredPermissions: ["flight.search"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "high",
    requiresApproval: true,
    requiredApprovalRole: "admin",
    // Not retried: this creates state (an approval request), so blindly
    // retrying a transient failure could create duplicate pending requests.
    retryPolicyOverride: { retryable: false, maxRetries: 0 },
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const approvalRequest = await AIApprovalRequestModel.create({
        tenantId: context.tenantId,
        branchId: context.branchId,
        executionId: context.executionId || null,
        toolName: "propose_flight_booking",
        arguments: args,
        riskLevel: "high",
        // "Not Responsible For: Database Updates" — the proposal carries the
        // exact real endpoint call a human approver hands off to; the AI
        // layer never invokes it itself, even after approval.
        proposedAction: {
          method: "POST",
          endpoint: "/api/v1/flight-bookings",
          body: {
            offerId: args.offerId,
            provider: args.provider || "Amadeus",
            travelers: [{ firstName: args.travelerFirstName, lastName: args.travelerLastName, passportNumber: args.passportNumber }]
          }
        },
        requestedBy: context.userId,
        requestedByName: context.userName || "User",
        requiredRole: "admin",
        status: "pending"
      });
      publishEvent("AIApprovalRequested", { approvalRequestId: approvalRequest._id, tenantId: context.tenantId, toolName: "propose_flight_booking" });
      return { approvalRequestId: approvalRequest._id, status: "pending", message: "Booking proposal created. Awaiting human approval before any reservation is made." };
    }
  },
  {
    name: "propose_hotel_booking",
    description: "Propose booking a specific hotel room offer (obtained from a prior get_hotel_room_offers call, already re-verified via verify_hotel_offer_pricing). This NEVER creates a real reservation — it only creates a pending approval request. A human with the required role must explicitly approve it via POST /api/v1/ai/tools/approval before any booking happens (§14 'AI never creates bookings without explicit user approval').",
    parameters: {
      type: "object",
      properties: {
        hotelOfferId: { type: "string" },
        guestFirstName: { type: "string" },
        guestLastName: { type: "string" },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" }
      },
      required: ["hotelOfferId", "guestFirstName", "guestLastName"]
    },
    outputSchema: { type: "object", description: "{ approvalRequestId, status: 'pending', message }" },
    requiredPermissions: ["travel.hotel.book"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "high",
    requiresApproval: true,
    requiredApprovalRole: "admin",
    // Not retried: this creates state (an approval request), same
    // reasoning as propose_flight_booking above.
    retryPolicyOverride: { retryable: false, maxRetries: 0 },
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const approvalRequest = await AIApprovalRequestModel.create({
        tenantId: context.tenantId,
        branchId: context.branchId,
        executionId: context.executionId || null,
        toolName: "propose_hotel_booking",
        arguments: args,
        riskLevel: "high",
        proposedAction: {
          method: "POST",
          endpoint: "/api/v1/integrations/amadeus/hotels/book",
          body: {
            hotelOfferId: args.hotelOfferId,
            guests: [{ firstName: args.guestFirstName, lastName: args.guestLastName }],
            contact: { email: args.contactEmail || undefined, phone: args.contactPhone || undefined }
          }
        },
        requestedBy: context.userId,
        requestedByName: context.userName || "User",
        requiredRole: "admin",
        status: "pending"
      });
      publishEvent("AIApprovalRequested", { approvalRequestId: approvalRequest._id, tenantId: context.tenantId, toolName: "propose_hotel_booking" });
      return { approvalRequestId: approvalRequest._id, status: "pending", message: "Hotel booking proposal created. Awaiting human approval before any reservation is made." };
    }
  },
  {
    name: "propose_hotel_cancellation",
    description: "Propose cancelling an existing confirmed hotel reservation. This NEVER cancels anything itself — it only creates a pending approval request. A human with the required role must explicitly approve it via POST /api/v1/ai/tools/approval before the reservation is cancelled (§14 'AI never cancels reservations without explicit user approval'). Before proposing, explain the cancellation policy and estimated refund/penalty to the user using get_hotel_booking_details.",
    parameters: {
      type: "object",
      properties: {
        providerBookingId: { type: "string", description: "e.g. AMD-HOTEL-9834521" },
        reason: { type: "string" }
      },
      required: ["providerBookingId", "reason"]
    },
    outputSchema: { type: "object", description: "{ approvalRequestId, status: 'pending', message }" },
    requiredPermissions: ["travel.hotel.cancel"],
    requiredRoles: [],
    executionType: "Synchronous",
    riskLevel: "high",
    requiresApproval: true,
    requiredApprovalRole: "admin",
    retryPolicyOverride: { retryable: false, maxRetries: 0 },
    version: "1.0.0",
    ownerModule: "GDSIntegration",
    handler: async (args, context) => {
      const approvalRequest = await AIApprovalRequestModel.create({
        tenantId: context.tenantId,
        branchId: context.branchId,
        executionId: context.executionId || null,
        toolName: "propose_hotel_cancellation",
        arguments: args,
        riskLevel: "high",
        proposedAction: {
          method: "POST",
          endpoint: `/api/v1/integrations/amadeus/hotels/bookings/${args.providerBookingId}/cancel`,
          body: { reason: args.reason }
        },
        requestedBy: context.userId,
        requestedByName: context.userName || "User",
        requiredRole: "admin",
        status: "pending"
      });
      publishEvent("AIApprovalRequested", { approvalRequestId: approvalRequest._id, tenantId: context.tenantId, toolName: "propose_hotel_cancellation" });
      return { approvalRequestId: approvalRequest._id, status: "pending", message: "Hotel cancellation proposal created. Awaiting human approval before the reservation is cancelled." };
    }
  }
];

let registeredEventPublished = false;

class AIToolRegistry {
  /** Publishes AIToolRegistered once, the first time the registry is read — genuine "tools registered at boot" semantics. */
  static _ensureRegistered() {
    if (registeredEventPublished) return;
    registeredEventPublished = true;
    publishEvent("AIToolRegistered", { toolCount: TOOLS.length, tools: TOOLS.map((t) => t.name) });
  }

  static list() {
    this._ensureRegistered();
    return TOOLS;
  }

  static getSchemas() {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /** Full "Tool Registry" metadata (API-006G §6), filtered to what the caller's permissions actually allow. */
  static getCatalog(permissions = []) {
    return this.list()
      .filter((t) => t.requiredPermissions.length === 0 || hasPermission(permissions, t.requiredPermissions))
      .map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters, outputSchema: t.outputSchema,
        requiredPermissions: t.requiredPermissions, requiredRoles: t.requiredRoles, executionType: t.executionType,
        timeoutMs: getAIConfig().toolDefaultTimeoutMs, retryPolicy: t.retryPolicyOverride || defaultRetryPolicy(),
        version: t.version, ownerModule: t.ownerModule, riskLevel: t.riskLevel, requiresApproval: t.requiresApproval
      }));
  }

  static getTool(name) {
    return this.list().find((t) => t.name === name) || null;
  }

  static getRetryPolicy(tool) {
    return tool.retryPolicyOverride || defaultRetryPolicy();
  }

  /** "MCP Ready" — real, verifiable schema mapping to the MCP tool-definition shape (name/description/inputSchema). No live MCP transport server is stood up here; see the doc's Completion Status for the honest scope line. */
  static toMCPToolDefinition(tool) {
    return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
  }

  static getMCPCatalog(permissions = []) {
    return this.list()
      .filter((t) => t.requiredPermissions.length === 0 || hasPermission(permissions, t.requiredPermissions))
      .map((t) => this.toMCPToolDefinition(t));
  }

  /**
   * "Permission Validator" — executes a tool only if the calling user's
   * own real permissions satisfy the tool's requirement, exactly the same
   * check the underlying REST endpoint would perform. `requiredPermissions:
   * []` means the tool enforces its own scoping internally.
   */
  static async execute(name, args, context) {
    const tool = this.getTool(name);
    if (!tool) {
      return { error: `Unknown tool '${name}'.` };
    }
    if (tool.requiredPermissions.length > 0 && !hasPermission(context.permissions || [], tool.requiredPermissions)) {
      return { error: `Permission denied: this action requires one of [${tool.requiredPermissions.join(", ")}].`, denied: true };
    }
    // EXT-026 §13 "Rate Limiting" — checked after permission (no point
    // spending a rate-limit slot on a request that was going to be denied
    // anyway) but before the handler runs.
    const rateLimitResult = AIToolRateLimiter.check({ tenantId: context.tenantId, userId: context.userId, toolName: name });
    if (!rateLimitResult.allowed) {
      publishEvent("AIToolRateLimited", { tenantId: context.tenantId, userId: context.userId, toolName: name, scope: rateLimitResult.scope });
      return { error: `Rate limit exceeded for this action (${rateLimitResult.scope} limit). Please try again in a moment.`, rateLimited: true, retryAfterMs: rateLimitResult.retryAfterMs };
    }
    try {
      const result = await tool.handler(args || {}, context);
      return { result };
    } catch (err) {
      return { error: err.message || "Tool execution failed." };
    }
  }
}

export default AIToolRegistry;
