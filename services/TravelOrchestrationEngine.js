import { publishEvent, subscribeEvent } from "../utils/eventBus.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import CacheManager from "../utils/cacheManager.js";

// Dashboard reads go through AnalyticsEngine's CacheManager.getOrCompute —
// calling buildPrimaryDashboard again here would just return the still-cached
// (stale) value within its TTL, not force a recompute. Invalidating the
// pattern is what actually makes "Dashboard Updated" real per business
// event, per next read recomputes fresh instead of waiting out the TTL/cron.
const invalidateDashboardCache = (tenantId) => CacheManager.invalidatePattern(`dashboard:*:${tenantId}:*`);

/**
 * Travel Orchestration Engine
 * Coordinates long-running business process workflows across Travel Operations domains.
 */
class TravelOrchestrationEngine {
  /**
   * Initialize Orchestrator and register event listeners
   */
  static init() {
    // 1. Travel Plan Lifecycle
    subscribeEvent("TravelPlanCreated", async (payload) => {
      await this.orchestrateTravelPlanInitialization(payload);
    });

    // 2. Flight Operations
    subscribeEvent("FlightAssigned", async (payload) => {
      await this.orchestrateFlightAssignment(payload);
    });

    // 3. Hotel Operations
    subscribeEvent("HotelAssigned", async (payload) => {
      await this.orchestrateHotelAssignment(payload);
    });

    // 4. Transport Operations
    subscribeEvent("TransportAssigned", async (payload) => {
      await this.orchestrateTransportAssignment(payload);
    });

    // 5. Attendance & Missing Traveler Workflow
    subscribeEvent("AttendanceRecorded", async (payload) => {
      await this.orchestrateAttendanceUpdate(payload);
    });

    // The real event published on a missed attendance check is
    // "TravelerMarkedMissing" (controllers/TravelAttendanceController.js) —
    // this subscribed to "TravelerMissing", a name nothing ever publishes,
    // so this handler was permanently unreachable dead code.
    subscribeEvent("TravelerMarkedMissing", async (payload) => {
      await this.orchestrateMissingTravelerAlert(payload);
    });

    // 6. Incident Management Lifecycle
    subscribeEvent("IncidentCreated", async (payload) => {
      await this.orchestrateIncidentFlow(payload);
    });

    subscribeEvent("IncidentResolved", async (payload) => {
      await this.orchestrateIncidentResolution(payload);
    });

    console.log("[TravelOrchestratorEngine] Initialized and listening for domain events.");
  }

  /**
   * Orchestrates complete travel plan lifecycle setup
   */
  static async orchestrateTravelPlanInitialization({ travelPlanId, tenantId, bookingId, coordinatorId }) {
    try {
      console.log(`[Orchestrator] Starting Travel Plan Orchestration for TP: ${travelPlanId}`);

      // 1. Log Canonical Timeline Event
      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "WorkflowEngine",
        aggregateType: "TravelPlan",
        aggregateId: travelPlanId,
        eventType: "WorkflowInitialized",
        title: "Travel Workflow Initialized",
        description: `Operational workflow started for booking ${bookingId}`,
        actor: { userId: coordinatorId || "System", name: "Travel Orchestrator", role: "System" },
        visibility: "Operations"
      });

      // Search indexing for TravelPlan is handled centrally by
      // SearchEngineService.init()'s own TravelPlanCreated subscription
      // (real DB lookup + correct permissionsRequired), not duplicated here.

      await invalidateDashboardCache(tenantId);

      // 4. Publish WorkflowCompleted event
      publishEvent("TravelWorkflowInitialized", { travelPlanId, tenantId });
    } catch (err) {
      console.error("[Orchestrator] Error orchestrating travel plan:", err);
    }
  }

  /**
   * Orchestrates Flight Assignment event workflow
   */
  static async orchestrateFlightAssignment({ flightAssignmentId, travelPlanId, flightNumber, pnr, tenantId, userId }) {
    try {
      console.log(`[Orchestrator] Handling Flight Assignment for PNR ${pnr}`);

      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "FlightOperations",
        aggregateType: "FlightAssignment",
        aggregateId: flightAssignmentId,
        eventType: "FlightAssigned",
        title: "Flight Leg Assigned",
        description: `Flight ${flightNumber} (PNR: ${pnr}) assigned to Travel Plan`,
        actor: { userId: userId || "System", name: "Ops Coordinator", role: "Flight Coordinator" },
        visibility: "Public"
      });

      // Search indexing for Flight is handled centrally by
      // SearchEngineService.init()'s own FlightAssigned subscription.

      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error handling FlightAssignment:", err);
    }
  }

  /**
   * Orchestrates Hotel Assignment event workflow
   */
  static async orchestrateHotelAssignment({ hotelAssignmentId, travelPlanId, hotelName, roomType, tenantId, userId }) {
    try {
      console.log(`[Orchestrator] Handling Hotel Assignment for ${hotelName}`);

      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "HotelOperations",
        aggregateType: "HotelAssignment",
        aggregateId: hotelAssignmentId,
        eventType: "HotelAssigned",
        title: "Hotel Stay Allocated",
        description: `Hotel ${hotelName} (${roomType}) assigned`,
        actor: { userId: userId || "System", name: "Hotel Coordinator", role: "Hotel Coordinator" },
        visibility: "Public"
      });

      // Search indexing for Hotel is handled centrally by
      // SearchEngineService.init()'s own HotelAssigned subscription.

      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error handling HotelAssignment:", err);
    }
  }

  /**
   * Orchestrates Transport Assignment event workflow
   */
  static async orchestrateTransportAssignment({ transportAssignmentId, travelPlanId, vehicleType, routeName, tenantId, userId }) {
    try {
      console.log(`[Orchestrator] Handling Transport Assignment for ${routeName}`);

      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "TransportOperations",
        aggregateType: "TransportAssignment",
        aggregateId: transportAssignmentId,
        eventType: "VehicleAssigned",
        title: "Transport Vehicle Allocated",
        description: `Vehicle (${vehicleType}) assigned for route ${routeName}`,
        actor: { userId: userId || "System", name: "Transport Dispatcher", role: "Transport Coordinator" },
        visibility: "Operations"
      });

      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error handling TransportAssignment:", err);
    }
  }

  /**
   * Orchestrates Attendance Record updates
   */
  static async orchestrateAttendanceUpdate({ sessionId, travelPlanId, status, tenantId }) {
    try {
      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error handling AttendanceRecorded:", err);
    }
  }

  /**
   * Orchestrates Missing Traveler Emergency Escalation
   */
  static async orchestrateMissingTravelerAlert({ sessionId, travelPlanId, travelerId, travelerName, tenantId }) {
    try {
      console.warn(`[Orchestrator] CRITICAL: Traveler ${travelerName || travelerId} marked MISSING${sessionId ? ` on session ${sessionId}` : ""}`);

      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "Attendance",
        aggregateType: "AttendanceSession",
        aggregateId: sessionId || travelerId,
        eventType: "TravelerMissing",
        title: "CRITICAL ALERT: Traveler Missing",
        description: `Traveler ${travelerName || travelerId} failed attendance check`,
        actor: { userId: "System", name: "Attendance Monitor", role: "System" },
        visibility: "Operations"
      });

      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error handling TravelerMissing:", err);
    }
  }

  /**
   * Orchestrates emergency & high-severity incident escalation
   */
  static async orchestrateIncidentFlow({ incidentId, incidentNumber, travelPlanId, severity, tenantId }) {
    try {
      console.log(`[Orchestrator] Handling Incident Event for ${incidentNumber} (${severity})`);

      // Search indexing for Incident is handled centrally by
      // SearchEngineService.init()'s own IncidentCreated subscription
      // (indexIncident) — this used to duplicate it with a second,
      // no-permissionsRequired indexEntity call racing the same upsert.

      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error orchestrating incident:", err);
    }
  }

  /**
   * Orchestrates incident resolution workflow
   */
  static async orchestrateIncidentResolution({ incidentId, incidentNumber, travelPlanId, tenantId }) {
    try {
      console.log(`[Orchestrator] Handling Incident Resolution for ${incidentNumber}`);

      await recordCanonicalDomainEvent({
        travelPlanId,
        tenantId,
        sourceModule: "IncidentManagement",
        aggregateType: "Incident",
        aggregateId: incidentId,
        eventType: "IncidentResolved",
        title: `Incident ${incidentNumber} Resolved`,
        description: `Case closed and CAPA verified for incident ${incidentNumber}`,
        actor: { userId: "System", name: "Incident System", role: "System" },
        visibility: "Operations"
      });

      await invalidateDashboardCache(tenantId);
    } catch (err) {
      console.error("[Orchestrator] Error handling IncidentResolved:", err);
    }
  }
}

export default TravelOrchestrationEngine;

