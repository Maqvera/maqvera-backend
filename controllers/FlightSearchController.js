import GdsIntegrationService from "../services/GdsIntegrationService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * 1. POST /api/v1/flight-search
 * Live flight availability search across GDS providers.
 */
export const SearchFlights = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || "default";
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
      currency = "PKR",
      preferredProvider
    } = req.body;

    if (!origin || !destination || !departureDate) {
      return sendError(res, 400, "origin, destination, and departureDate are required.", requestId);
    }

    if (tripType === "RoundTrip" && !returnDate) {
      return sendError(res, 400, "returnDate is required for RoundTrip search.", requestId);
    }

    const searchParams = {
      tenantId,
      tripType,
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      departureDate,
      returnDate,
      adults: Number(adults),
      children: Number(children),
      infants: Number(infants),
      cabin,
      preferredAirlines,
      directOnly: Boolean(directOnly),
      currency,
      preferredProvider
    };

    const searchResponse = await GdsIntegrationService.searchFlights(searchParams);

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
    const { offerId, provider = "Amadeus" } = req.body;
    if (!offerId) {
      return sendError(res, 400, "offerId is required.", requestId);
    }

    const rulesResult = await GdsIntegrationService.getFareRules({ offerId, provider });

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
    const { offerId, provider = "Amadeus" } = req.body;
    const pricingResult = await GdsIntegrationService.getAirlinePricing({ offerId, provider });

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
