import { publishEvent, subscribeEvent } from "../utils/eventBus.js";
import { recordCanonicalDomainEvent } from "../controllers/TravelNotesTimelineController.js";
import SearchEngineService from "./SearchEngineService.js";
import AnalyticsEngine from "./AnalyticsEngine.js";

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

      // 2. Index Travel Plan in Enterprise Search Engine
      await SearchEngineService.indexEntity({
        tenantId,
        entityType: "TravelPlan",
        entityId: travelPlanId,
        title: `Travel Plan ${travelPlanId}`,
        description: `Execution plan for booking ${bookingId}`,
        keywords: [travelPlanId, bookingId, "Umrah", "TravelPlan"],
        module: "TravelOperations",
        navigationUrl: `/travel-plans/${travelPlanId}`
      });

      // 3. Trigger Analytics Summary Refresh
      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });

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

      await SearchEngineService.indexEntity({
        tenantId,
        entityType: "Flight",
        entityId: flightAssignmentId,
        title: `Flight ${flightNumber} (PNR ${pnr})`,
        description: `Flight booking for Travel Plan ${travelPlanId}`,
        keywords: [flightNumber, pnr, travelPlanId, "Flight"],
        module: "FlightOperations",
        navigationUrl: `/travel-plans/${travelPlanId}/flights`
      });

      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
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

      await SearchEngineService.indexEntity({
        tenantId,
        entityType: "Hotel",
        entityId: hotelAssignmentId,
        title: `Hotel Stay: ${hotelName}`,
        description: `${roomType} stay for Travel Plan ${travelPlanId}`,
        keywords: [hotelName, roomType, travelPlanId, "Hotel"],
        module: "HotelOperations",
        navigationUrl: `/travel-plans/${travelPlanId}/hotels`
      });

      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
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

      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
    } catch (err) {
      console.error("[Orchestrator] Error handling TransportAssignment:", err);
    }
  }

  /**
   * Orchestrates Attendance Record updates
   */
  static async orchestrateAttendanceUpdate({ sessionId, travelPlanId, status, tenantId }) {
    try {
      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
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

      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
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

      await SearchEngineService.indexEntity({
        tenantId,
        entityType: "Incident",
        entityId: incidentId,
        title: `[${severity}] ${incidentNumber}`,
        description: `Incident reported for Travel Plan ${travelPlanId}`,
        keywords: [incidentNumber, severity, "Incident"],
        module: "IncidentManagement",
        navigationUrl: `/incidents/${incidentId}`
      });

      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
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

      await AnalyticsEngine.buildPrimaryDashboard({ tenantId });
    } catch (err) {
      console.error("[Orchestrator] Error handling IncidentResolved:", err);
    }
  }
}

export default TravelOrchestrationEngine;

