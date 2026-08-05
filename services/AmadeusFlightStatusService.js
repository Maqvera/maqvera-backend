import mongoose from "mongoose";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import GdsIntegrationService from "./GdsIntegrationService.js";
import { throwStructured } from "./AmadeusFlightBookingService.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import { publishEvent } from "../utils/eventBus.js";
import { executeWorkflowTransition, getOrCreateWorkflowInstance } from "../utils/WorkflowEngine.js";
import { getFlightStatusPolicy } from "../utils/gdsConfig.js";

const FLIGHT_NUMBER_PATTERN = /^[A-Z]{1,3}\d{1,4}[A-Z]?$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Live status -> the Flight workflow action that reaches it, only for the
// statuses this codebase's real state machine (utils/flightConfig.js) can
// actually represent as a transition. "Scheduled"/"Boarding"/"Gate Open"/
// "Unknown" have no dedicated post-ticketing action and are reported in the
// response without attempting an internal transition.
const STATUS_TO_ACTION = {
  Delayed: "Report Delay",
  Departed: "Depart",
  "In Flight": "Confirm In Flight",
  Arrived: "Arrive"
};

/**
 * EXT-011 — Amadeus Flight Status API. A read-only lookup that ALSO tries,
 * best-effort, to sync a matching internal TravelFlightAssignmentModel
 * through the same workflow engine the manual staff status-update endpoint
 * (TravelFlightController.js) already uses — never bypassing its guard
 * conditions/approval gates. The live/sandbox status DTO is always returned
 * regardless of whether internal sync succeeds ("Read-only integration" —
 * this endpoint's own response is never blocked by an internal write).
 */
class AmadeusFlightStatusService {
  static async getStatus({ tenantId, userId, userName, flightNumber, airlineCode, departureDate, originAirport, destinationAirport, requestId, triggeredBy = "on_demand" }) {
    // §9 "Valid Flight Number" / "Valid Date".
    if (!flightNumber || !FLIGHT_NUMBER_PATTERN.test(String(flightNumber))) {
      throwStructured("A valid flightNumber is required (e.g. SV701 or 701 with airlineCode).", "INVALID_REQUEST", 400);
    }
    const resolvedDate = departureDate || new Date().toISOString().slice(0, 10);
    if (!DATE_ONLY_PATTERN.test(resolvedDate) || Number.isNaN(new Date(resolvedDate).getTime())) {
      throwStructured("departureDate must be a valid YYYY-MM-DD date.", "INVALID_REQUEST", 400);
    }

    // Extract a plain numeric flight number + carrier code from combined
    // input like "SV701" when airlineCode wasn't supplied separately.
    let resolvedAirlineCode = airlineCode;
    let resolvedFlightNumber = String(flightNumber).replace(/\s+/g, "");
    if (!resolvedAirlineCode) {
      const match = /^([A-Z]{1,3})(\d{1,4}[A-Z]?)$/i.exec(resolvedFlightNumber);
      if (match) { resolvedAirlineCode = match[1]; resolvedFlightNumber = match[2]; }
    } else {
      resolvedFlightNumber = resolvedFlightNumber.replace(/^[A-Z]{1,3}/i, "");
    }

    // "OAuth Active" / "Tenant Authorized" — circuit breaker is the real
    // proxy for provider connectivity, same convention as every other
    // Amadeus-facing service in this codebase.
    if (!GdsIntegrationService.circuitBreaker.canAttempt("Amadeus")) {
      throwStructured("Amadeus is currently unavailable (circuit breaker open).", "PROVIDER_UNAVAILABLE", 503);
    }

    let liveStatus;
    try {
      liveStatus = await GdsIntegrationService.getFlightStatus({
        provider: "Amadeus", flightNumber: resolvedFlightNumber, airlineCode: resolvedAirlineCode, departureDate: resolvedDate, originAirport, destinationAirport, tenantId
      });
    } catch (err) {
      const code = err.code || (err.status === 429 ? "RATE_LIMIT_EXCEEDED" : err.status === 504 ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
      const status = code === "FLIGHT_NOT_FOUND" ? 404 : code === "RATE_LIMIT_EXCEEDED" ? 429 : code === "PROVIDER_TIMEOUT" ? 504 : 503;
      if (mongoose.connection?.readyState === 1) {
        AuditLogModel.create({
          tenantId, userId, action: "AMADEUS_FLIGHT_STATUS_FAILED", module: "ExternalIntegrations",
          requestId, details: { flightNumber: resolvedFlightNumber, airlineCode: resolvedAirlineCode, departureDate: resolvedDate, code, reason: err.message }
        }).catch((auditErr) => console.error("Flight status failure audit log error:", auditErr));
      }
      throwStructured(code === "FLIGHT_NOT_FOUND" ? err.message : "Flight status is temporarily unavailable. Please try again.", code, status);
    }

    // "Compare Previous Status" / "Update Internal Flight Assignment" —
    // best-effort, never fails the response. Matches on flightNumber +
    // plannedDeparture's calendar day, since that's the only reliable join
    // key a status lookup (which has no flightAssignmentId) can use.
    await AmadeusFlightStatusService._syncInternalAssignment({ tenantId, userId, userName, liveStatus, flightNumber: resolvedFlightNumber, airlineCode: resolvedAirlineCode, departureDate: resolvedDate, requestId, triggeredBy });

    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "AMADEUS_FLIGHT_STATUS_VIEWED", module: "ExternalIntegrations",
        requestId, details: { flightNumber: liveStatus.flightNumber, status: liveStatus.status, source: liveStatus._source || "unknown" }
      }).catch((err) => console.error("Flight status audit log error:", err));
    }

    return {
      flightNumber: liveStatus.flightNumber,
      airline: liveStatus.airline,
      status: liveStatus.status,
      scheduledDeparture: liveStatus.scheduledDeparture,
      estimatedDeparture: liveStatus.estimatedDeparture,
      scheduledArrival: liveStatus.scheduledArrival,
      estimatedArrival: liveStatus.estimatedArrival,
      terminal: liveStatus.terminal,
      gate: liveStatus.gate,
      aircraft: liveStatus.aircraft,
      delayMinutes: liveStatus.delayMinutes
    };
  }

  static async _syncInternalAssignment({ tenantId, userId, userName, liveStatus, flightNumber, airlineCode, departureDate, requestId, triggeredBy = "on_demand" }) {
    try {
      const dayStart = new Date(`${departureDate}T00:00:00.000Z`);
      const dayEnd = new Date(`${departureDate}T23:59:59.999Z`);
      const flight = await TravelFlightAssignmentModel.findOne({
        tenantId, flightNumber, plannedDeparture: { $gte: dayStart, $lte: dayEnd }
      });
      if (!flight) return;

      // EXT-018 §3/§16 "FlightScheduleSynchronized" — published whenever a
      // matching internal flight was found and successfully compared
      // against live data, regardless of whether anything actually
      // changed ("we synchronized" is true either way); distinct from the
      // more specific change events below, which only fire when something
      // genuinely changed.
      publishEvent("FlightScheduleSynchronized", { flightAssignmentId: flight._id, tenantId, flightNumber: flight.flightNumber, triggeredBy, status: liveStatus.status, source: liveStatus._source || "unknown" });

      let touched = false;
      const previousGate = flight.gate;
      const previousTerminal = flight.terminal;

      // Gate/terminal aren't workflow-governed fields — direct sync, same
      // as the manual UpdateTravelPlanFlight endpoint's own approach.
      if (liveStatus.gate && liveStatus.gate !== previousGate) {
        flight.gate = liveStatus.gate;
        touched = true;
      }
      if (liveStatus.terminal && liveStatus.terminal !== previousTerminal) {
        flight.terminal = liveStatus.terminal;
        touched = true;
      }

      const gateActuallyChanged = touched && previousGate && liveStatus.gate && previousGate !== liveStatus.gate;
      // §9 "Terminal Changed" — same "already syncing the field but never
      // published a dedicated event" gap the gate side already had fixed;
      // mirrors gateActuallyChanged's exact detection logic.
      const terminalActuallyChanged = previousTerminal && liveStatus.terminal && previousTerminal !== liveStatus.terminal;

      // §4/§9 "Aircraft Changed" — direct sync, not workflow-governed,
      // same approach as gate/terminal. Honestly skipped when the live
      // response has no confirmed aircraft data (§4 "Aircraft" — Amadeus's
      // own `legs[].aircraftEquipment` is not always present).
      const previousAircraft = flight.aircraft;
      const aircraftActuallyChanged = Boolean(liveStatus.aircraft && previousAircraft && liveStatus.aircraft !== previousAircraft);
      if (liveStatus.aircraft && liveStatus.aircraft !== previousAircraft) {
        flight.aircraft = liveStatus.aircraft;
        touched = true;
      }

      // §9 "Flight Rescheduled" — distinct from an on-the-day delay:
      // Amadeus's CURRENT scheduled departure/arrival (queried for the
      // SAME calendar date already stored) differing from what this
      // codebase already had on file by more than the configured
      // threshold means the airline changed its timetable since booking,
      // not just today's estimate. EXT-011 never updated
      // plannedDeparture/plannedArrival at all — a real, previously-silent
      // gap this document closes.
      const { rescheduleThresholdMinutes } = getFlightStatusPolicy();
      let rescheduled = false;
      if (liveStatus.scheduledDeparture) {
        const newDeparture = new Date(liveStatus.scheduledDeparture);
        const shiftMinutes = Math.abs(newDeparture.getTime() - flight.plannedDeparture.getTime()) / 60000;
        if (shiftMinutes >= rescheduleThresholdMinutes) {
          flight.plannedDeparture = newDeparture;
          if (liveStatus.scheduledArrival) flight.plannedArrival = new Date(liveStatus.scheduledArrival);
          rescheduled = true;
          touched = true;
        }
      }

      if (liveStatus.status === "Delayed" && liveStatus.delayMinutes > 0) {
        flight.delayHistory.push({
          reason: "Reported by Amadeus live status", expectedDelayMinutes: liveStatus.delayMinutes, actualDelayMinutes: liveStatus.delayMinutes,
          reportedAt: new Date(), reportedBy: "Amadeus Flight Status Sync"
        });
        touched = true;
      }
      if (liveStatus.status === "Departed" && liveStatus.estimatedDeparture) {
        flight.actualDeparture = new Date(liveStatus.estimatedDeparture);
        touched = true;
      }
      if (liveStatus.status === "Arrived" && liveStatus.estimatedArrival) {
        flight.actualArrival = new Date(liveStatus.estimatedArrival);
        touched = true;
      }

      // Best-effort workflow transition — pre-seed the instance with the
      // flight's REAL current status (see the identical fix applied to
      // TravelFlightController.js's manual endpoint) so this isn't blocked
      // by the same "draft" seeding bug. Silently skipped (not failed) when
      // the transition isn't valid from the flight's current state — an
      // automated status poll must never force an invalid/approval-gated
      // transition.
      const action = STATUS_TO_ACTION[liveStatus.status];
      let transitionApplied = false;
      if (action) {
        await getOrCreateWorkflowInstance({ tenantId, entityType: "Flight", entityId: flight._id, initialState: flight.status });
        try {
          const transitionResult = await executeWorkflowTransition({
            tenantId, entityType: "Flight", entityId: flight._id, action,
            performedBy: userId || "system", performedByName: userName || "Amadeus Flight Status Sync",
            userRoles: [], comments: `Automated sync from Amadeus live status (${liveStatus.status}).`
          });
          if (!transitionResult.requiresApproval) {
            flight.status = transitionResult.currentState;
            touched = true;
            transitionApplied = true;
          }
        } catch (err) {
          console.warn(`[EXT-011] Skipped internal status transition for flight ${flight._id}: ${err.message}`);
        }
      }

      if (!touched) return;

      flight.version = (flight.version || 1) + 1;
      flight.versionHistory.push({
        version: flight.version, updatedBy: "system", updatedAt: new Date(),
        changes: { action: "AMADEUS_STATUS_SYNC", liveStatus: liveStatus.status, gate: flight.gate, terminal: flight.terminal, aircraft: flight.aircraft, rescheduled, triggeredBy }
      });
      await flight.save();

      if (flight.travelPlanId) {
        await recordCanonicalDomainEvent({
          travelPlanId: flight.travelPlanId, tenantId, sourceModule: "ExternalIntegrations",
          aggregateType: "FlightAssignment", aggregateId: flight._id, eventType: "FlightStatusUpdated",
          title: `Flight ${flight.flightNumber} Status: ${liveStatus.status}`,
          description: `Synced from Amadeus live status. ${liveStatus.delayMinutes > 0 ? `Delay: ${liveStatus.delayMinutes} min. ` : ""}${gateActuallyChanged ? `Gate changed from ${previousGate} to ${liveStatus.gate}. ` : ""}${terminalActuallyChanged ? `Terminal changed from ${previousTerminal} to ${liveStatus.terminal}. ` : ""}${rescheduled ? `Flight rescheduled to ${flight.plannedDeparture.toISOString()}. ` : ""}`,
          actor: { userId: "system", name: "Amadeus Flight Status Sync", role: "System" }
        });
      }

      publishEvent("FlightStatusUpdated", { travelPlanId: flight.travelPlanId, flightAssignmentId: flight._id, status: flight.status, tenantId });

      if (liveStatus.status === "Delayed" && liveStatus.delayMinutes > 0) {
        publishEvent("FlightDelayed", { flightAssignmentId: flight._id, tenantId, delayMinutes: liveStatus.delayMinutes });
      }
      if (["Cancelled", "Diverted", "Returned"].includes(liveStatus.status)) {
        publishEvent("FlightCancelled", { flightAssignmentId: flight._id, tenantId, status: liveStatus.status });
      }
      if (gateActuallyChanged) {
        // "GateChanged" already exists and is published elsewhere
        // (UpdateTravelPlanFlight) — kept alongside the doc-named
        // "FlightGateChanged" rather than renamed, same fix pattern applied
        // throughout this EXT-series whenever a doc names an event this
        // codebase already publishes under a different name.
        publishEvent("GateChanged", { travelPlanId: flight.travelPlanId, flightAssignmentId: flight._id, gate: flight.gate, tenantId });
        publishEvent("FlightGateChanged", { flightAssignmentId: flight._id, tenantId, previousGate, gate: flight.gate });
      }
      if (terminalActuallyChanged) {
        publishEvent("TerminalChanged", { travelPlanId: flight.travelPlanId, flightAssignmentId: flight._id, tenantId, previousTerminal, terminal: flight.terminal });
      }
      if (rescheduled) {
        publishEvent("FlightRescheduled", { travelPlanId: flight.travelPlanId, flightAssignmentId: flight._id, tenantId, plannedDeparture: flight.plannedDeparture, plannedArrival: flight.plannedArrival });
      }
      if (aircraftActuallyChanged) {
        publishEvent("AircraftChanged", { flightAssignmentId: flight._id, tenantId, previousAircraft, aircraft: flight.aircraft });
      }
      if (transitionApplied && liveStatus.status === "Departed") {
        publishEvent("FlightDeparted", { flightAssignmentId: flight._id, tenantId });
      }
      if (transitionApplied && liveStatus.status === "Arrived") {
        publishEvent("FlightArrived", { flightAssignmentId: flight._id, tenantId });
      }

      // "Notify Stakeholders" — no real Email/SMS/WhatsApp/Push provider
      // exists in this codebase; same honest pattern as EXT-005/009/010.
      if (liveStatus.status === "Delayed" || gateActuallyChanged || terminalActuallyChanged || rescheduled || ["Cancelled", "Diverted", "Returned"].includes(liveStatus.status)) {
        for (const role of ["OperationsTeam", "AirportCoordinator", "TravelCoordinator"]) {
          publishEvent("NotificationRequested", { tenantId, event: "FlightStatusUpdated", priority: "high", channel: "Email", recipientRole: role, flightAssignmentId: flight._id, status: liveStatus.status });
        }
      }
    } catch (err) {
      // Internal sync is best-effort by design — never let a sync failure
      // fail the read-only status response itself.
      console.error("[EXT-011] Internal flight assignment sync failed:", err.message);
    }
  }
}

export default AmadeusFlightStatusService;
