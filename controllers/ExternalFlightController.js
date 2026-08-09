import mongoose from "mongoose";
import AmadeusFlightSearchService from "../services/AmadeusFlightSearchService.js";
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
 * EXT-002 §5-9. GET /api/v1/external/flights/search — the pure Amadeus
 * adapter contract: query params, Amadeus only (no Sabre fallback — that
 * stays inside API-006B's multi-provider GdsIntegrationService.searchFlights),
 * Standard Flight DTO response. Reuses the exact same validation policy
 * (getFlightSearchValidationConfig) already proven for API-006B so both
 * search contracts enforce identical rules, not two different standards
 * for the same underlying data.
 */
export const SearchAmadeusFlights = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];

    if (!permissions.includes("flight.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      origin, destination, departureDate, returnDate,
      adults = "1", children = "0", infants = "0",
      travelClass = "ECONOMY", nonStop, currency = "PKR", maxResults
    } = req.query;

    // Validation Rules §8: Origin required, Destination required, Departure
    // date required, Origin ≠ Destination, Departure cannot be in past,
    // Adults >= 1, Maximum passengers configurable.
    if (!origin || !destination || !departureDate) {
      return sendError(res, 400, "origin, destination, and departureDate are required.", requestId);
    }

    const originCode = String(origin).toUpperCase();
    const destinationCode = String(destination).toUpperCase();
    if (!IATA_CODE_PATTERN.test(originCode) || !IATA_CODE_PATTERN.test(destinationCode)) {
      return sendError(res, 400, "origin and destination must be valid 3-letter IATA airport codes.", requestId);
    }
    if (originCode === destinationCode) {
      return sendError(res, 400, "origin and destination cannot be the same airport.", requestId);
    }

    const policy = getFlightSearchValidationConfig();
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
    if (returnDate) {
      const ret = toStartOfDay(returnDate);
      if (!ret) return sendError(res, 400, "returnDate is not a valid date.", requestId);
      if (ret < departure) return sendError(res, 400, "returnDate must be on or after departureDate.", requestId);
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
    if (adultsCount + childrenCount + infantsCount > policy.maxPassengers) {
      return sendError(res, 400, `Total passengers cannot exceed ${policy.maxPassengers}.`, requestId);
    }

    const normalizedCabin = String(travelClass).toUpperCase() === "ECONOMY" ? "Economy"
      : String(travelClass).toUpperCase() === "PREMIUM_ECONOMY" ? "PremiumEconomy"
      : String(travelClass).toUpperCase() === "BUSINESS" ? "Business"
      : String(travelClass).toUpperCase() === "FIRST" ? "First"
      : null;
    if (!normalizedCabin || !policy.supportedCabins.includes(normalizedCabin)) {
      return sendError(res, 400, `Unsupported travelClass '${travelClass}'. Must be one of: ECONOMY, PREMIUM_ECONOMY, BUSINESS, FIRST.`, requestId);
    }
    if (!policy.supportedCurrencies.includes(currency)) {
      return sendError(res, 400, `Unsupported currency '${currency}'. Must be one of: ${policy.supportedCurrencies.join(", ")}.`, requestId);
    }

    const result = await AmadeusFlightSearchService.search({
      tenantId,
      origin: originCode,
      destination: destinationCode,
      departureDate,
      returnDate: returnDate || undefined,
      adults: adultsCount,
      children: childrenCount,
      infants: infantsCount,
      travelClass: normalizedCabin,
      nonStop: nonStop === "true" || nonStop === true,
      currency,
      maxResults: maxResults ? parseInt(maxResults, 10) : undefined,
      correlationId: requestId
    });

    // §15 "Log: Search Time, Provider, Request ID, Correlation ID, Latency,
    // Status. Never log access tokens." — real audit entry, no token value
    // anywhere in `details`.
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "EXTERNAL_FLIGHT_SEARCH", module: "ExternalIntegrations",
        requestId, details: { provider: "Amadeus", origin: originCode, destination: destinationCode, totalOffers: result.offers.length, fromCache: result.fromCache, latencyMs: result.latencyMs || 0 }
      }).catch((err) => console.error("External flight search audit log error:", err));
    }

    return sendSuccess(res, 200, "Live Amadeus flight search completed successfully.", {
      provider: "Amadeus",
      correlationId: result.correlationId,
      fromCache: result.fromCache,
      totalOffers: result.offers.length,
      offers: result.offers
    }, requestId);
  } catch (err) {
    console.error("SearchAmadeusFlights Error:", err);
    // §13 "Internal clients never receive raw provider errors." — the
    // adapter/circuit-breaker error message is already business-safe (no
    // raw Amadeus payload ever reaches this catch block), but this is the
    // boundary where that guarantee is enforced regardless.
    const statusCode = err.code === "PROVIDER_UNAVAILABLE" ? 503 : 500;
    return sendError(res, statusCode, statusCode === 503 ? err.message : "Flight search is temporarily unavailable. Please try again.", requestId);
  }
};

/** GET /api/v1/external/flights/metrics — §16. */
export const GetAmadeusMetrics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("flight.search") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    return sendSuccess(res, 200, "Amadeus integration metrics retrieved successfully.", AmadeusFlightSearchService.getMetrics(), requestId);
  } catch (err) {
    console.error("GetAmadeusMetrics Error:", err);
    return sendError(res, 500, err.message || "Failed to retrieve Amadeus metrics.", requestId);
  }
};
