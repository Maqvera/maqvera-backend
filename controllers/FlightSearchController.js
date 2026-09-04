import mongoose from "mongoose";
import GdsIntegrationService from "../services/GdsIntegrationService.js";
import CurrencyService from "../services/CurrencyService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getFlightSearchValidationConfig } from "../utils/gdsConfig.js";

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;

const toStartOfDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * 1. POST /api/v1/flight-search
 * Live flight availability search across GDS providers.
 */
export const SearchFlights = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];

    // "Authorization: Required (flight.search)"
    if (!permissions.includes("flight.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      tripType = "OneWay",
      origin,
      destination,
      departureDate,
      returnDate,
      adults = 1,
      children = 0,
      infants = 0,
      cabin = "Economy",
      preferredAirlines = [],
      directOnly = false,
      preferredProvider
    } = req.body;
    // Golden Rule 2 (never hardcode a currency) — resolves to the tenant's
    // own configured base currency instead of a literal "PKR".
    const currency = (req.body.currency || await CurrencyService.getBaseCurrency(tenantId)).toUpperCase();

    if (!origin || !destination || !departureDate) {
      return sendError(res, 400, "origin, destination, and departureDate are required.", requestId);
    }

    const originCode = String(origin).toUpperCase();
    const destinationCode = String(destination).toUpperCase();
    const policy = getFlightSearchValidationConfig();

    // Validation Rules — "Origin/Destination Airport Exists" (structural IATA
    // format check; no bundled global airport reference table exists in this
    // codebase, and fabricating a handful of fake airport rows would be
    // worse than an honest format check), "Departure Date Valid",
    // "Return Date Valid", "Passenger Count Valid", "Cabin Valid",
    // "Currency Supported" — none of these were enforced before this fix.
    if (!IATA_CODE_PATTERN.test(originCode) || !IATA_CODE_PATTERN.test(destinationCode)) {
      return sendError(res, 400, "origin and destination must be valid 3-letter IATA airport codes.", requestId);
    }
    if (originCode === destinationCode) {
      return sendError(res, 400, "origin and destination cannot be the same airport.", requestId);
    }

    const today = toStartOfDay(new Date());
    const departure = toStartOfDay(departureDate);
    if (!departure) {
      return sendError(res, 400, "departureDate is not a valid date.", requestId);
    }
    if (departure < today) {
      return sendError(res, 400, "departureDate cannot be in the past.", requestId);
    }
    const maxAdvanceDate = new Date(today.getTime() + policy.maxAdvanceBookingDays * 24 * 60 * 60 * 1000);
    if (departure > maxAdvanceDate) {
      return sendError(res, 400, `departureDate cannot be more than ${policy.maxAdvanceBookingDays} days in the future.`, requestId);
    }

    if (tripType === "RoundTrip") {
      if (!returnDate) {
        return sendError(res, 400, "returnDate is required for RoundTrip search.", requestId);
      }
      const ret = toStartOfDay(returnDate);
      if (!ret) {
        return sendError(res, 400, "returnDate is not a valid date.", requestId);
      }
      if (ret < departure) {
        return sendError(res, 400, "returnDate must be on or after departureDate.", requestId);
      }
    }

    const adultsCount = Number(adults);
    const childrenCount = Number(children);
    const infantsCount = Number(infants);
    if (!Number.isInteger(adultsCount) || adultsCount < 1) {
      return sendError(res, 400, "At least 1 adult passenger is required.", requestId);
    }
    if (!Number.isInteger(childrenCount) || childrenCount < 0 || !Number.isInteger(infantsCount) || infantsCount < 0) {
      return sendError(res, 400, "children and infants must be non-negative whole numbers.", requestId);
    }
    const totalPassengers = adultsCount + childrenCount + infantsCount;
    if (totalPassengers > policy.maxPassengers) {
      return sendError(res, 400, `Total passengers cannot exceed ${policy.maxPassengers}.`, requestId);
    }

    if (!policy.supportedCabins.includes(cabin)) {
      return sendError(res, 400, `Unsupported cabin '${cabin}'. Must be one of: ${policy.supportedCabins.join(", ")}.`, requestId);
    }
    if (!policy.supportedCurrencies.includes(currency)) {
      return sendError(res, 400, `Unsupported currency '${currency}'. Must be one of: ${policy.supportedCurrencies.join(", ")}.`, requestId);
    }

    const searchParams = {
      tenantId,
      correlationId: requestId,
      tripType,
      origin: originCode,
      destination: destinationCode,
      departureDate,
      returnDate,
      adults: adultsCount,
      children: childrenCount,
      infants: infantsCount,
      cabin,
      preferredAirlines,
      directOnly: Boolean(directOnly),
      currency,
      preferredProvider
    };

    const searchResponse = await GdsIntegrationService.searchFlights(searchParams);

    // AI Coding Rule "Audit Searches" — fire-and-forget, never blocks a
    // read-only search response, and skipped entirely when Mongo isn't
    // connected (a required-DB dependency would defeat the point of caching
    // live GDS results for fast repeat reads).
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "FLIGHT_SEARCH", module: "GdsIntegration",
        requestId, details: { origin: originCode, destination: destinationCode, tripType, provider: searchResponse.provider, totalOffers: searchResponse.meta?.totalOffers }
      }).catch((err) => console.error("Flight search audit log error:", err));
    }

    return sendSuccess(res, 200, "Live flight search completed successfully.", searchResponse, requestId);
  } catch (err) {
    console.error("SearchFlights Controller Error:", err);
    return sendError(res, 500, err.message || "Failed to search live flights.", requestId);
  }
};

/**
 * 2. GET /api/v1/flight-search/:searchId
 * Returns cached flight search results by search ID.
 */
export const GetSearchById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { searchId } = req.params;
    const searchData = await GdsIntegrationService.getSearchById(searchId);

    if (!searchData) {
      return sendError(res, 404, "Search results expired or not found. Please initiate a new search.", requestId);
    }

    return sendSuccess(res, 200, "Cached flight search results retrieved successfully.", searchData, requestId);
  } catch (err) {
    console.error("GetSearchById Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve search results.", requestId);
  }
};

/**
 * 3. POST /api/v1/flight-search/revalidate
 * Price & seat availability revalidation before booking.
 */
export const RevalidateOffer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required for revalidation.", requestId);
    }

    const revalidationResult = await GdsIntegrationService.revalidateOffer({ offerId, provider });

    return sendSuccess(res, 200, "Flight offer revalidated successfully.", revalidationResult, requestId);
  } catch (err) {
    console.error("RevalidateOffer Error:", err);
    return sendError(res, 500, err.message || "Failed to revalidate flight offer.", requestId);
  }
};

/**
 * 4. POST /api/v1/flight-search/calendar
 * Flexible date low-fare calendar search.
 */
export const GetCalendarSearch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { origin, destination, departureDate, provider = "Amadeus" } = req.body;
    if (!origin || !destination) {
      return sendError(res, 400, "origin and destination are required for calendar search.", requestId);
    }

    const calendarResult = await GdsIntegrationService.getCalendarSearch({ origin, destination, departureDate, provider });

    return sendSuccess(res, 200, "Low fare calendar retrieved successfully.", calendarResult, requestId);
  } catch (err) {
    console.error("GetCalendarSearch Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve calendar pricing.", requestId);
  }
};

/**
 * 5. POST /api/v1/flight-search/fare-rules
 * Cancellation penalties & change fee rules for offer.
 */
export const GetFareRules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }
    const currency = (req.body.currency || await CurrencyService.getBaseCurrency(tenantId)).toUpperCase();

    const rulesResult = await GdsIntegrationService.getFareRules({ offerId, provider, currency });

    return sendSuccess(res, 200, "Fare rules retrieved successfully.", rulesResult, requestId);
  } catch (err) {
    console.error("GetFareRules Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch fare rules.", requestId);
  }
};

/**
 * 6. POST /api/v1/flight-search/baggage
 * Detailed baggage allowance breakdown.
 */
export const GetBaggageInfo = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    const baggageResult = await GdsIntegrationService.getBaggageInfo({ offerId, provider });

    return sendSuccess(res, 200, "Baggage information retrieved successfully.", baggageResult, requestId);
  } catch (err) {
    console.error("GetBaggageInfo Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch baggage info.", requestId);
  }
};

/**
 * 7. POST /api/v1/flight-search/seat-map
 * Seat map availability grid.
 */
export const GetSeatMap = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { flightNumber, provider = "Amadeus" } = req.body;
    if (!flightNumber) {
      return sendError(res, 400, "flightNumber is required.", requestId);
    }

    const seatMapResult = await GdsIntegrationService.getSeatMap({ flightNumber, provider });

    return sendSuccess(res, 200, "Seat map retrieved successfully.", seatMapResult, requestId);
  } catch (err) {
    console.error("GetSeatMap Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch seat map.", requestId);
  }
};

/**
 * 8. POST /api/v1/flight-search/airline-pricing
 * Airline base fare & tax breakdown.
 */
export const GetAirlinePricing = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const { offerId, provider = "Amadeus" } = req.body;
    const currency = (req.body.currency || await CurrencyService.getBaseCurrency(tenantId)).toUpperCase();
    const pricingResult = await GdsIntegrationService.getAirlinePricing({ offerId, provider, currency });

    return sendSuccess(res, 200, "Airline pricing breakdown retrieved successfully.", pricingResult, requestId);
  } catch (err) {
    console.error("GetAirlinePricing Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch airline pricing.", requestId);
  }
};

/**
 * 9. GET /api/v1/flight-search/providers/status
 * Health & circuit status of GDS providers.
 */
export const GetProviderStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const statusData = await GdsIntegrationService.getProviderStatus();

    return sendSuccess(res, 200, "GDS Provider status retrieved successfully.", statusData, requestId);
  } catch (err) {
    console.error("GetProviderStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to check provider status.", requestId);
  }
};
