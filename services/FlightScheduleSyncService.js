import mongoose from "mongoose";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import FlightCatalogModel from "../models/FlightCatalogModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AmadeusFlightStatusService from "./AmadeusFlightStatusService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFlightScheduleSyncPolicy } from "../utils/gdsConfig.js";
import logger from "../utils/logger.js";

// §7 "Only Active Travel Plans" / "Skip Completed Flights" / "Cancelled
// Flights Ignored" — travel-plan-level and flight-level terminal states,
// matching TravelPlanModel/TravelFlightAssignmentModel's real enums.
const TERMINAL_TRAVEL_PLAN_STATUSES = ["completed", "archived", "cancelled"];
const TERMINAL_FLIGHT_STATUSES = ["completed", "cancelled"];
const HIGH_PRIORITY_TIERS = ["high", "vip"];

// §15 "Maximum Retries 5 / Retry Delay 30 Seconds / Exponential Backoff /
// Dead Letter Queue". This codebase has no message-queue broker (see
// CLAUDE.md's event bus note: EVENT_BUS_TRANSPORT=memory is in-process
// only, no Redis Streams/RabbitMQ/Kafka adapter implemented yet) — so
// "dead letter queue" is honestly implemented as an in-memory
// per-process attempt/backoff tracker, permanently recorded via the same
// durable AuditLogModel every other EXT document in this session already
// uses for failure tracking, rather than fabricating a queue system that
// doesn't exist.
const retryState = new Map(); // flightAssignmentId(string) -> { attempts, nextEligibleAt, deadLettered }

/**
 * EXT-018 — Amadeus Flight Schedule Synchronization. Does NOT duplicate
 * EXT-011's live-status/compare/update/publish logic — it drives it.
 * `AmadeusFlightStatusService.getStatus({ ..., triggeredBy: "scheduler" })`
 * is the exact same call path the live GET /flights/status endpoint uses;
 * this service's only real job is finding WHICH flights are due for a
 * background sync and calling that existing path for each one, with
 * retry/backoff bookkeeping layered on top.
 */
class FlightScheduleSyncService {
  /** Resolves a real IATA airline code for a flight assignment — via its FlightCatalogModel entry when linked, else a best-effort parse of the flight number itself (same fallback EXT-011's own getStatus already does when no airlineCode is supplied). */
  static async _resolveAirlineCode(flight) {
    if (flight.flightCatalogId) {
      const catalogEntry = await FlightCatalogModel.findById(flight.flightCatalogId).select("airlineCode").lean();
      if (catalogEntry?.airlineCode) return catalogEntry.airlineCode;
    }
    // Defensive normalization: flight numbers in this codebase have been
    // observed in both hyphenated ("SV-701", from raw GDS search
    // normalization) and bare ("SV701") forms depending on entry path —
    // strip separators before attempting to extract a leading carrier code.
    const normalized = String(flight.flightNumber || "").replace(/[\s-]/g, "");
    const match = /^([A-Z]{1,3})(\d{1,4}[A-Z]?)$/i.exec(normalized);
    return match ? match[1].toUpperCase() : null;
  }

  /** §7 business-rule query — active travel plan, ticketed, not completed/cancelled, within the configured lookahead window, one priority tier. */
  static async _findEligibleFlights({ tenantId, tier, config }) {
    const activePlanIds = await TravelPlanModel.find({ tenantId, status: { $nin: TERMINAL_TRAVEL_PLAN_STATUSES } }).distinct("_id");
    if (activePlanIds.length === 0) return [];

    const now = new Date();
    const windowEnd = new Date(now.getTime() + config.syncWindowDaysAhead * 86400000);
    const priorityFilter = tier === "high" ? { $in: HIGH_PRIORITY_TIERS } : { $nin: HIGH_PRIORITY_TIERS };

    return TravelFlightAssignmentModel.find({
      tenantId,
      travelPlanId: { $in: activePlanIds },
      ticketStatus: "Issued",
      status: { $nin: TERMINAL_FLIGHT_STATUSES },
      priority: priorityFilter,
      plannedDeparture: { $gte: new Date(now.getTime() - 86400000), $lte: windowEnd } // include flights up to 1 day past departure (still syncable — arrival/status may still be updating) but never far-future ones.
    }).limit(config.batchSize).lean();
  }

  static _isRetryEligible(flightId) {
    const entry = retryState.get(flightId);
    if (!entry) return true;
    if (entry.deadLettered) return false;
    return Date.now() >= entry.nextEligibleAt;
  }

  static async _recordFailure({ flight, tenantId, config, error }) {
    const flightId = String(flight._id);
    const entry = retryState.get(flightId) || { attempts: 0, nextEligibleAt: 0, deadLettered: false };
    entry.attempts += 1;

    if (entry.attempts >= config.maxRetries) {
      entry.deadLettered = true;
      retryState.set(flightId, entry);
      publishEvent("FlightScheduleSyncFailed", { flightAssignmentId: flight._id, tenantId, attempts: entry.attempts, reason: error.message, deadLettered: true });
      if (mongoose.connection?.readyState === 1) {
        await AuditLogModel.create({
          tenantId, userId: "system", action: "FLIGHT_SCHEDULE_SYNC_DEAD_LETTERED", module: "ExternalIntegrations",
          details: { flightAssignmentId: flight._id, flightNumber: flight.flightNumber, attempts: entry.attempts, reason: error.message }
        }).catch((err) => console.error("Flight schedule sync dead-letter audit log error:", err));
      }
      logger.error(`[EXT-018] Flight ${flight.flightNumber} (${flightId}) dead-lettered after ${entry.attempts} failed sync attempts: ${error.message}`);
      return;
    }

    entry.nextEligibleAt = Date.now() + config.retryDelayMs * 2 ** (entry.attempts - 1);
    retryState.set(flightId, entry);
    logger.warn(`[EXT-018] Flight ${flight.flightNumber} (${flightId}) sync attempt ${entry.attempts}/${config.maxRetries} failed: ${error.message}. Next eligible in ${Math.round((entry.nextEligibleAt - Date.now()) / 1000)}s.`);
  }

  /** One flight's full sync attempt — resolve airline code, call the SAME service the live status endpoint uses, track retry state. */
  static async _syncOne({ flight, tenantId, config }) {
    const flightId = String(flight._id);
    if (!FlightScheduleSyncService._isRetryEligible(flightId)) return "skipped_backoff";

    try {
      const airlineCode = await FlightScheduleSyncService._resolveAirlineCode(flight);
      const normalizedFlightNumber = String(flight.flightNumber || "").replace(/[\s-]/g, "");
      // getStatus already strips a leading carrier-code prefix from
      // flightNumber whenever airlineCode is supplied separately (verified
      // EXT-011 behavior) — passing the full normalized flight number here
      // alongside the resolved airlineCode is correct without any extra
      // stripping on this end.
      await AmadeusFlightStatusService.getStatus({
        tenantId, userId: "system", userName: "Flight Schedule Sync Scheduler",
        flightNumber: normalizedFlightNumber, airlineCode,
        departureDate: flight.plannedDeparture.toISOString().slice(0, 10),
        originAirport: flight.originAirport, destinationAirport: flight.destinationAirport,
        triggeredBy: "scheduler"
      });
      retryState.delete(flightId); // success resets any prior backoff/attempt history.
      return "synced";
    } catch (err) {
      await FlightScheduleSyncService._recordFailure({ flight, tenantId, config, error: err });
      return "failed";
    }
  }

  /** §3 full workflow for one tenant/priority tier — the scheduler calls this per active tenant per tick. */
  static async syncTenant({ tenantId, tier }) {
    if (mongoose.connection?.readyState !== 1) return { synced: 0, failed: 0, skipped: 0 };
    const config = getFlightScheduleSyncPolicy();
    const flights = await FlightScheduleSyncService._findEligibleFlights({ tenantId, tier, config });

    let synced = 0, failed = 0, skipped = 0;
    for (const flight of flights) {
      const outcome = await FlightScheduleSyncService._syncOne({ flight, tenantId, config });
      if (outcome === "synced") synced += 1;
      else if (outcome === "failed") failed += 1;
      else skipped += 1;
    }

    return { synced, failed, skipped, total: flights.length };
  }

  /** Mirrors AnalyticsScheduler's own tenant-discovery pattern — no hardcoded tenant list. */
  static async _getActiveTenants() {
    if (mongoose.connection.readyState !== 1) return [];
    try {
      const UserModel = mongoose.model("user");
      const tenants = await UserModel.distinct("tenantId", { status: "active", tenantId: { $ne: null } });
      return tenants.filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Entry point for both scheduler tiers (and manual/dashboard-triggered sync, §5 "Trigger Sources"). */
  static async runSyncCycle({ tier = "standard", triggeredBy = "scheduler" } = {}) {
    if (mongoose.connection?.readyState !== 1) {
      logger.warn("[EXT-018] Flight schedule sync skipped — database not connected.");
      return null;
    }
    const startedAt = Date.now();
    const tenants = await FlightScheduleSyncService._getActiveTenants();
    let totals = { synced: 0, failed: 0, skipped: 0, total: 0 };

    for (const tenantId of tenants) {
      const result = await FlightScheduleSyncService.syncTenant({ tenantId, tier });
      totals.synced += result.synced;
      totals.failed += result.failed;
      totals.skipped += result.skipped;
      totals.total += result.total;
    }

    const durationMs = Date.now() - startedAt;
    logger.info(`[EXT-018] Flight schedule sync cycle (${tier}, ${triggeredBy}) completed: ${totals.synced} synced, ${totals.failed} failed, ${totals.skipped} skipped, ${tenants.length} tenant(s), ${durationMs}ms.`);
    return { ...totals, tenantCount: tenants.length, durationMs, tier, triggeredBy };
  }
}

export default FlightScheduleSyncService;
