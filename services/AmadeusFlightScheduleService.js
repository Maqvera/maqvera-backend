import mongoose from "mongoose";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import CacheManager from "../utils/cacheManager.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFlightSchedulePolicy } from "../utils/gdsConfig.js";

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toStartOfDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * EXT-012 — Amadeus Flight Schedule API. Read-only lookup of planned
 * (unpriced) scheduled flights for a future origin/destination/date, used
 * for planning/itinerary-generation rather than booking. Cached (§16 "Redis
 * Cache... TTL 30 Minutes") since schedule data changes far less often than
 * EXT-011's live operational status, which is deliberately never cached.
 */
class AmadeusFlightScheduleService {
  static async getSchedules({ tenantId, userId, origin, destination, departureDate, airlineCode, nonStop, maxResults, requestId }) {
    // §9 "Origin Required" / "Destination Required" / "Valid IATA Airport Codes".
    if (!origin || !destination) {
      throwStructured("origin and destination are required.", "INVALID_REQUEST", 400);
    }
    const originCode = String(origin).toUpperCase();
    const destinationCode = String(destination).toUpperCase();
    if (!IATA_CODE_PATTERN.test(originCode) || !IATA_CODE_PATTERN.test(destinationCode)) {
      throwStructured("origin and destination must be valid 3-letter IATA airport codes.", "INVALID_REQUEST", 400);
    }
    if (originCode === destinationCode) {
      throwStructured("origin and destination cannot be the same airport.", "INVALID_REQUEST", 400);
    }

    // "Travel Date Valid".
    if (!departureDate || !DATE_ONLY_PATTERN.test(departureDate)) {
      throwStructured("departureDate is required and must be a valid YYYY-MM-DD date.", "INVALID_REQUEST", 400);
    }
    const policy = getFlightSchedulePolicy();
    const today = toStartOfDay(new Date());
    const requested = toStartOfDay(departureDate);
    if (!requested) {
      throwStructured("departureDate is not a valid calendar date.", "INVALID_REQUEST", 400);
    }
    if (requested < today) {
      throwStructured("departureDate cannot be in the past.", "INVALID_REQUEST", 400);
    }
    const maxDate = new Date(today.getTime() + policy.maxAdvanceBookingDays * 86400000);
    if (requested > maxDate) {
      throwStructured(`departureDate cannot be more than ${policy.maxAdvanceBookingDays} days in the future.`, "INVALID_REQUEST", 400);
    }

    const resolvedAirlineCode = airlineCode ? String(airlineCode).toUpperCase() : null;
    const resolvedNonStop = nonStop === true || nonStop === "true";
    const resolvedMaxResults = maxResults ? Math.max(1, Math.min(50, Number.parseInt(maxResults, 10) || 10)) : null;

    // "OAuth Active" — circuit breaker is the real proxy for provider
    // connectivity, same convention as every other Amadeus-facing service.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    const cacheKey = `gds:flight-schedule:${tenantId}:${originCode}:${destinationCode}:${departureDate}:${resolvedAirlineCode || "any"}:${resolvedNonStop ? "nonstop" : "any"}:${resolvedMaxResults || "all"}`;

    let providerResult;
    let fromCache = false;
    try {
      const cached = await CacheManager.get(cacheKey);
      if (cached) {
        providerResult = cached;
        fromCache = true;
      } else {
        providerResult = await GdsIntegrationService.getFlightSchedules({
          provider: "Amadeus", origin: originCode, destination: destinationCode, departureDate,
          airlineCode: resolvedAirlineCode, nonStop: resolvedNonStop, maxResults: resolvedMaxResults
        });
        await CacheManager.set(cacheKey, providerResult, policy.cacheTtlSeconds);
      }
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_FLIGHT_SCHEDULE_FAILED", module: "ExternalIntegrations",
          requestId, details: { origin: originCode, destination: destinationCode, departureDate, code, reason: err.message }
        }).catch((auditErr) => console.error("Flight schedule failure audit log error:", auditErr));
      }
      throwStructured("Flight schedule is temporarily unavailable. Please try again.", code, status);
    }

    const schedules = providerResult.schedules || [];
    const insights = AmadeusFlightScheduleService._buildInsights(schedules);

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_FLIGHT_SCHEDULE_VIEWED", module: "ExternalIntegrations",
        requestId, details: { origin: originCode, destination: destinationCode, departureDate, count: schedules.length, source: providerResult._source, fromCache }
      }).catch((err) => console.error("Flight schedule audit log error:", err));
    }

    // "Schedule Retrieved" — real, every successful lookup, cached or not.
    publishEvent("FlightScheduleRetrieved", { tenantId, origin: originCode, destination: destinationCode, departureDate, count: schedules.length, source: providerResult._source });

    return {
      origin: originCode,
      destination: destinationCode,
      departureDate,
      schedules,
      insights,
      meta: { count: schedules.length, provider: "Amadeus", source: providerResult._source, fromCache, cacheTtlSeconds: policy.cacheTtlSeconds }
    };
  }

  /**
   * §15 "AI Integration — AI Assistant may suggest best departure times,
   * recommend shortest/least-stop journeys, detect overnight flights,
   * compare airlines, recommend business-friendly/Umrah-friendly
   * schedules." These are real, deterministic derivations over the
   * schedule data actually returned — "AI analyzes schedule data only" —
   * not a fabricated model output; an AI Assistant consuming this response
   * reasons over these fields rather than the raw list.
   */
  static _buildInsights(schedules) {
    if (schedules.length === 0) {
      return { shortestFlightNumber: null, leastStopsFlightNumber: null, overnightFlightNumbers: [], businessFriendlyFlightNumbers: [], airlinesCompared: [] };
    }

    const parseDurationMinutes = (label) => {
      const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(String(label || "").trim());
      if (!match) return Number.MAX_SAFE_INTEGER;
      return (Number.parseInt(match[1] || "0", 10) * 60) + Number.parseInt(match[2] || "0", 10);
    };
    const isOvernight = (s) => {
      if (!s.departure || !s.arrival) return false;
      const dep = new Date(s.departure);
      const arr = new Date(s.arrival);
      return dep.getUTCDate() !== arr.getUTCDate() || dep.getUTCHours() >= 22 || dep.getUTCHours() < 4;
    };
    const isBusinessFriendly = (s) => {
      if (!s.departure) return false;
      const hour = new Date(s.departure).getUTCHours();
      return hour >= 6 && hour <= 21 && !isOvernight(s);
    };

    const shortest = schedules.reduce((best, s) => (parseDurationMinutes(s.duration) < parseDurationMinutes(best.duration) ? s : best), schedules[0]);
    const leastStops = schedules.reduce((best, s) => (s.stops < best.stops ? s : best), schedules[0]);

    return {
      shortestFlightNumber: shortest.flightNumber,
      leastStopsFlightNumber: leastStops.flightNumber,
      overnightFlightNumbers: schedules.filter(isOvernight).map((s) => s.flightNumber),
      businessFriendlyFlightNumbers: schedules.filter(isBusinessFriendly).map((s) => s.flightNumber),
      airlinesCompared: [...new Set(schedules.map((s) => s.airline))]
    };
  }
}

export default AmadeusFlightScheduleService;
