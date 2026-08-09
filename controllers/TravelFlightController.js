import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import FlightCatalogModel from "../models/FlightCatalogModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
// AirlineConnector currently only returns simulated/mock GDS data (see its
// own source comments) — not wired into flight-status logic here, since
// writing its fabricated output into real flight records would itself be
// the "fake data" STEP 3 forbids. Part 3's actual documented workflow for
// status changes is the manual PATCH .../status endpoint below, not a live
// GDS poll. Kept imported as the established integration point for when a
// real GDS/airline API is configured.
import { AirlineConnector } from "../utils/SupplierIntegrationLayer.js";
import { getFlightConfig } from "../utils/flightConfig.js";
import { getAllowedNextActions, executeWorkflowTransition, getOrCreateWorkflowInstance } from "../utils/WorkflowEngine.js";
import { getAccessScope } from "../utils/accessScope.js";

const flightConfig = getFlightConfig();

// Helper for timeline logging
const recordTravelTimeline = async ({ travelPlanId, tenantId, eventType, title, description, performedBy = null, metadata = {} }) => {
  try {
    await TravelTimelineModel.create({
      travelPlanId,
      tenantId,
      module: "FlightOperations",
      eventType,
      title: title || eventType,
      description: description || title || eventType,
      performedBy,
      performedByName: "Staff",
      metadata
    });
  } catch (err) {
    console.error("recordTravelTimeline error:", err);
  }
};

/**
 * 1. GET /api/v1/travel-plans/:travelPlanId/flights
 * Returns all flights assigned to a travel plan.
 */
export const ListTravelPlanFlights = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    // Business Rule: "Supports pagination."
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "20", 10), 1), 100);

    const filter = { travelPlanId, tenantId };
    const totalItems = await TravelFlightAssignmentModel.countDocuments(filter);
    const flights = await TravelFlightAssignmentModel.find(filter)
      .sort({ plannedDeparture: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    const formattedFlights = flights.map((f) => ({
      flightAssignmentId: f._id,
      travelPlanId: f.travelPlanId,
      airline: f.airline,
      flightNumber: f.flightNumber,
      originAirport: f.originAirport,
      destinationAirport: f.destinationAirport,
      plannedDeparture: f.plannedDeparture,
      plannedArrival: f.plannedArrival,
      actualDeparture: f.actualDeparture,
      actualArrival: f.actualArrival,
      terminal: f.terminal,
      gate: f.gate,
      aircraft: f.aircraft,
      durationMinutes: f.durationMinutes,
      status: f.status,
      priority: f.priority,
      assignedTravelersCount: f.assignedTravelers ? f.assignedTravelers.length : 0,
      assignedTravelers: f.assignedTravelers,
      delayHistory: f.delayHistory,
      incidentsCount: f.incidents ? f.incidents.length : 0,
      incidents: f.incidents,
      remarks: f.remarks,
      internalNotes: f.internalNotes,
      // AI Coding Rule "Workflow Engine" — surfaces the real, state-aware
      // next actions (utils/flightConfig.js) rather than leaving workflow
      // enforcement invisible to API consumers, mirroring Travel Plan's
      // GetTravelPlan.workflowSummary.availableTransitions.
      availableTransitions: getAllowedNextActions(f.status, "Flight"),
      createdAt: f.createdAt
    }));

    return sendSuccess(res, 200, "Flight assignments retrieved successfully.", {
      data: formattedFlights,
      meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) || 1 }
    }, requestId);
  } catch (err) {
    console.error("ListTravelPlanFlights Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch flights.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans/:travelPlanId/flights
 * Assigns one or more flights to a travel plan.
 */
export const AddTravelPlanFlights = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    if (["completed", "archived", "cancelled"].includes(travelPlan.status)) {
      return sendError(res, 400, `Cannot assign flights to a travel plan in '${travelPlan.status}' status.`, requestId);
    }

    let flightItems = [];
    if (Array.isArray(req.body.flights)) {
      flightItems = req.body.flights;
    } else if (req.body.airline || req.body.flightNumber || req.body.flightId || req.body.flightCatalogId) {
      flightItems = [req.body];
    } else {
      return sendError(res, 400, "Invalid payload. Pass 'flights' array or flight details object.", requestId);
    }

    const createdAssignments = [];

    for (const item of flightItems) {
      // Doc's request example uses "flightId"; flightCatalogId is the real
      // field name (matches FlightCatalogModel/flightCatalogId used
      // elsewhere in this codebase's Booking module) — both accepted.
      const flightCatalogId = item.flightCatalogId || item.flightId || null;
      const {
        plannedDeparture,
        plannedArrival,
        terminal = null,
        gate = null,
        priority = "normal",
        remarks = null,
        internalNotes = null
      } = item;

      if (!plannedDeparture || !plannedArrival) {
        return sendError(res, 400, "plannedDeparture and plannedArrival are required for each flight.", requestId);
      }

      const depDate = new Date(plannedDeparture);
      const arrDate = new Date(plannedArrival);

      if (isNaN(depDate.getTime()) || isNaN(arrDate.getTime())) {
        return sendError(res, 400, "Invalid plannedDeparture or plannedArrival format.", requestId);
      }

      if (arrDate <= depDate) {
        return sendError(res, 400, "plannedArrival must be after plannedDeparture.", requestId);
      }

      // "Flight Architecture: Flight Catalog -> Travel Flight Assignment" /
      // AI Coding Rule "Separate Flight Catalog." The primary documented
      // flow resolves real airline/flightNumber/route/aircraft from the
      // catalog via flightId — this used to silently fall back to a
      // hardcoded fake flight ("Saudia SV-732 JED->RUH") whenever those
      // fields were omitted, a direct STEP 3 violation. Ad-hoc (non-catalog)
      // entry remains supported for charter flights (Business Rule "Supports
      // charter flights"), but only with explicit real values — never a
      // fabricated default.
      let airline, flightNumber, originAirport, destinationAirport, aircraft, durationMinutes;

      if (flightCatalogId) {
        const catalogEntry = await FlightCatalogModel.findOne({ _id: flightCatalogId, tenantId, isActive: true });
        if (!catalogEntry) {
          return sendError(res, 422, `Flight "${flightCatalogId}" does not exist or is inactive.`, requestId);
        }
        airline = catalogEntry.airlineName;
        flightNumber = catalogEntry.flightNumber;
        originAirport = item.originAirport || catalogEntry.originAirport?.code;
        destinationAirport = item.destinationAirport || catalogEntry.destinationAirport?.code;
        aircraft = item.aircraft || catalogEntry.aircraftType;
        durationMinutes = catalogEntry.durationMinutes || Math.round((arrDate - depDate) / (1000 * 60));
      } else {
        // Charter flight path — no catalog entry, so every identifying
        // field must be explicitly provided by the caller.
        airline = item.airline;
        flightNumber = item.flightNumber;
        originAirport = item.originAirport;
        destinationAirport = item.destinationAirport;
        aircraft = item.aircraft;
        durationMinutes = Math.round((arrDate - depDate) / (1000 * 60));

        const missingFields = ["airline", "flightNumber", "originAirport", "destinationAirport", "aircraft"].filter((f) => !item[f]);
        if (missingFields.length > 0) {
          return sendError(res, 400, `Either provide flightId (catalog lookup) or all of: ${missingFields.join(", ")} (charter flight).`, requestId);
        }
      }

      // Validation Rule: "No Duplicate Flight Assignment"
      const existing = await TravelFlightAssignmentModel.findOne({
        travelPlanId,
        tenantId,
        flightNumber,
        plannedDeparture: depDate
      });

      if (existing) {
        return sendError(res, 400, `Flight ${flightNumber} on ${plannedDeparture} is already assigned to this travel plan.`, requestId);
      }

      const assignment = await TravelFlightAssignmentModel.create({
        travelPlanId,
        tenantId,
        flightCatalogId: flightCatalogId || null,
        airline,
        flightNumber,
        originAirport,
        destinationAirport,
        plannedDeparture: depDate,
        plannedArrival: arrDate,
        terminal,
        gate,
        aircraft,
        durationMinutes,
        status: flightConfig.defaultFlightStatus,
        priority,
        remarks,
        internalNotes,
        version: 1
      });

      createdAssignments.push(assignment);

      // Record Timeline & Event
      await recordTravelTimeline({
        travelPlanId,
        tenantId,
        eventType: "FlightAssigned",
        title: "Flight Assigned",
        description: `Flight ${airline} ${flightNumber} (${originAirport} -> ${destinationAirport}) assigned.`,
        performedBy: userId
      });

      publishEvent("FlightAssigned", {
        travelPlanId,
        flightAssignmentId: assignment._id,
        flightNumber,
        tenantId
      });
    }

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "FlightWorkflowInitialized",
      title: "Flight Workflow Initialized",
      description: `Flight tracking workflow initialized for ${createdAssignments.length} flight leg(s).`,
      performedBy: userId
    });
    // Domain Events (Part 3): FlightWorkflowInitialized — was previously
    // only a timeline log entry, never on the actual event bus.
    publishEvent("FlightWorkflowInitialized", {
      travelPlanId,
      tenantId,
      flightAssignmentIds: createdAssignments.map((a) => a._id)
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_FLIGHT_ASSIGNMENT",
        module: "FlightOperations",
        targetId: travelPlanId,
        details: { flightCount: createdAssignments.length }
      });
    } catch (auditErr) {
      console.error("Audit error:", auditErr);
    }

    return sendSuccess(res, 201, "Flight assignment(s) created successfully.", createdAssignments, requestId);
  } catch (err) {
    console.error("AddTravelPlanFlights Error:", err);
    return sendError(res, 500, err.message || "Failed to add flight assignment.", requestId);
  }
};

/**
 * 3. PATCH /api/v1/travel-plans/:travelPlanId/flights/:flightAssignmentId
 * Updates operational flight information.
 */
export const UpdateTravelPlanFlight = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, flightAssignmentId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const flight = await TravelFlightAssignmentModel.findOne({ _id: flightAssignmentId, travelPlanId, ...scope });
    if (!flight) {
      return sendError(res, 404, "Flight assignment not found.", requestId);
    }

    if (flight.status === "completed") {
      return sendError(res, 400, "Completed flights are locked and cannot be updated.", requestId);
    }

    // Business Rule: "Critical schedule changes require approval." Mirrors
    // the identical gate already applied to Booking and Travel Plan updates
    // — once a flight is past "scheduled" (i.e. already confirmed/ticketed/
    // in progress), changing its planned departure/arrival time is a
    // critical, rebooking-adjacent change. Gate/terminal changes are
    // explicitly NOT critical (that's why GateChanged is its own routine
    // domain event, distinct from FlightRescheduled).
    const touchesSchedule = req.body.plannedDeparture !== undefined || req.body.plannedArrival !== undefined;
    if (touchesSchedule && flight.status !== "scheduled") {
      if (!permissions.includes("admin")) {
        return sendError(res, 403, `Elevated permission required to change the schedule on a flight in '${flight.status}' status.`, requestId);
      }
    }

    const editableFields = [
      "plannedDeparture",
      "plannedArrival",
      "gate",
      "terminal",
      "remarks",
      "priority",
      "internalNotes",
      "aircraft"
    ];

    let scheduleChanged = false;
    let gateChanged = false;
    const changes = {};

    editableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        if (field === "plannedDeparture" || field === "plannedArrival") {
          const newDate = new Date(req.body[field]);
          if (!isNaN(newDate.getTime())) {
            changes[field] = newDate;
            scheduleChanged = true;
          }
        } else if (field === "gate") {
          changes.gate = req.body.gate;
          gateChanged = true;
        } else {
          changes[field] = req.body[field];
        }
      }
    });

    if (Object.keys(changes).length === 0) {
      return sendError(res, 400, "No valid fields provided for update.", requestId);
    }

    Object.assign(flight, changes);
    flight.version = (flight.version || 1) + 1;
    flight.versionHistory.push({
      version: flight.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await flight.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "FlightUpdated",
      title: "Flight Details Updated",
      description: `Flight ${flight.flightNumber} updated fields: ${Object.keys(changes).join(", ")}`,
      performedBy: userId,
      metadata: changes
    });

    if (scheduleChanged) {
      publishEvent("FlightRescheduled", { travelPlanId, flightAssignmentId, tenantId });
    }

    if (gateChanged) {
      publishEvent("GateChanged", { travelPlanId, flightAssignmentId, gate: flight.gate, tenantId });
    }

    publishEvent("FlightUpdated", { travelPlanId, flightAssignmentId, tenantId });

    return sendSuccess(res, 200, "Flight assignment updated successfully.", flight, requestId);
  } catch (err) {
    console.error("UpdateTravelPlanFlight Error:", err);
    return sendError(res, 500, err.message || "Failed to update flight assignment.", requestId);
  }
};

/**
 * 4. POST /api/v1/travel-plans/:travelPlanId/flights/:flightAssignmentId/travelers
 * Assigns travelers to a flight assignment.
 */
export const AssignTravelersToFlight = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, flightAssignmentId } = req.params;
    const { travelerIds } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!Array.isArray(travelerIds) || travelerIds.length === 0) {
      return sendError(res, 400, "travelerIds array is required.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    const flight = await TravelFlightAssignmentModel.findOne({ _id: flightAssignmentId, travelPlanId, ...scope });
    if (!flight) {
      return sendError(res, 404, "Flight assignment not found.", requestId);
    }

    // Business Rule: "Traveler belongs to Travel Plan" / "Duplicate
    // assignment prevented." IDs that don't resolve to a real traveler
    // snapshot or are already assigned are skipped and reported back
    // explicitly, rather than silently dropped, so the caller can see
    // exactly which of a bulk request succeeded.
    const existingAssignedIds = flight.assignedTravelers.map((t) => t.travelerId.toString());
    const skippedTravelerIds = [];
    let newlyAssignedCount = 0;

    travelerIds.forEach((tId) => {
      const travelerSnapshot = travelPlan.travelerSnapshots.find((s) => s.travelerId.toString() === tId.toString() || s._id.toString() === tId.toString());
      if (!travelerSnapshot) {
        skippedTravelerIds.push({ travelerId: tId, reason: "Not part of this travel plan." });
        return;
      }
      if (existingAssignedIds.includes(tId.toString())) {
        skippedTravelerIds.push({ travelerId: tId, reason: "Already assigned to this flight." });
        return;
      }
      flight.assignedTravelers.push({
        travelerId: travelerSnapshot.travelerId || travelerSnapshot._id,
        travelerName: travelerSnapshot.fullName || `${travelerSnapshot.firstName} ${travelerSnapshot.lastName}`,
        seatNumber: null,
        boardingStatus: "Not Boarded",
        checkInStatus: "Pending",
        baggageCount: 0
      });
      newlyAssignedCount++;
    });

    await flight.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TravelerAssignedToFlight",
      title: "Travelers Assigned to Flight",
      description: `Assigned ${newlyAssignedCount} traveler(s) to flight ${flight.flightNumber}`,
      performedBy: userId
    });

    publishEvent("TravelerAssignedToFlight", {
      travelPlanId,
      flightAssignmentId,
      newlyAssignedCount,
      tenantId
    });

    return sendSuccess(res, 200, `${newlyAssignedCount} traveler(s) assigned to flight successfully.`, {
      flight,
      newlyAssignedCount,
      skippedTravelerIds
    }, requestId);
  } catch (err) {
    console.error("AssignTravelersToFlight Error:", err);
    return sendError(res, 500, err.message || "Failed to assign travelers to flight.", requestId);
  }
};

/**
 * 5. PATCH /api/v1/travel-plans/:travelPlanId/flights/:flightAssignmentId/status
 * Updates live flight execution status & actual times.
 */
export const UpdateFlightExecutionStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, flightAssignmentId } = req.params;
    const { status, actualDeparture, actualArrival, delayDetails, action, comments } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!status && !action) {
      return sendError(res, 400, "status is required.", requestId);
    }

    const flight = await TravelFlightAssignmentModel.findOne({ _id: flightAssignmentId, travelPlanId, ...scope });
    if (!flight) {
      return sendError(res, 404, "Flight assignment not found.", requestId);
    }

    // "Validate Transition" — was previously a flat membership check against
    // an unordered status list with zero transition-validity checking (any
    // status could jump to any other, e.g. "completed" -> "scheduled"),
    // same "workflow bypass" bug class fixed for Booking/Travel Plan. Now
    // routed through the real, state-aware Flight workflow (utils/flightConfig.js).
    const normalizedStatus = status ? status.toLowerCase() : null;
    // EXT-011 audit finding: executeWorkflowTransition's own
    // getOrCreateWorkflowInstance() call never passes an initialState, so a
    // flight's FIRST transition attempt always seeded a workflow instance at
    // the hardcoded "draft" — a state that doesn't exist anywhere in the
    // Flight workflow definition, so it threw "not allowed from current
    // state 'draft'" every time. Booking already avoids this (see
    // BookingController.js) by pre-seeding its own instance with the real
    // current status first; Flight never did. Fixed the same way here.
    await getOrCreateWorkflowInstance({ tenantId, entityType: "Flight", entityId: flight._id, initialState: flight.status });
    let transitionResult;
    try {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "Flight",
        entityId: flight._id,
        action: action || null,
        targetState: normalizedStatus,
        performedBy: userId,
        performedByName: req.auth?.name || "Staff",
        userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : []),
        comments: comments || null
      });
    } catch (transitionErr) {
      return sendError(res, 400, transitionErr.message, requestId);
    }

    if (transitionResult.requiresApproval) {
      return sendSuccess(res, 202, transitionResult.message, {
        currentState: transitionResult.currentState,
        requiresApproval: true,
        approvalRole: transitionResult.approvalRole
      }, requestId);
    }

    const changes = { status: transitionResult.currentState };
    flight.status = transitionResult.currentState;

    if (actualDeparture) {
      flight.actualDeparture = new Date(actualDeparture);
      changes.actualDeparture = flight.actualDeparture;
    }

    if (actualArrival) {
      flight.actualArrival = new Date(actualArrival);
      changes.actualArrival = flight.actualArrival;
    }

    // AI Coding Rule: "Never overwrite historical records." Each delay
    // report is appended to delayHistory rather than merge-overwriting a
    // single object — a second, unrelated delay later in the flight's
    // lifecycle no longer erases the first.
    if (delayDetails && typeof delayDetails === "object") {
      const delayEntry = {
        reason: delayDetails.reason || null,
        expectedDelayMinutes: delayDetails.expectedDelayMinutes || 0,
        actualDelayMinutes: delayDetails.actualDelayMinutes || 0,
        resolution: delayDetails.resolution || null,
        responsibleParty: delayDetails.responsibleParty || null,
        reportedAt: new Date(),
        reportedBy: req.auth?.name || userId || "Staff"
      };
      flight.delayHistory.push(delayEntry);
      changes.delayEntry = delayEntry;
    }

    flight.version = (flight.version || 1) + 1;
    flight.versionHistory.push({
      version: flight.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await flight.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "FlightStatusUpdated",
      title: `Flight Status: ${transitionResult.currentState.toUpperCase()}`,
      description: `Flight ${flight.flightNumber} status updated to '${transitionResult.currentState}' via '${transitionResult.actionPerformed}'`,
      performedBy: userId,
      metadata: { status: transitionResult.currentState, actualDeparture, actualArrival }
    });

    publishEvent("FlightStatusUpdated", {
      travelPlanId,
      flightAssignmentId,
      status: transitionResult.currentState,
      tenantId
    });

    // Business Workflow: "Notify Operations" — matches the same
    // NotificationRequested convention already used by Booking's workflow
    // transitions.
    publishEvent("NotificationRequested", {
      travelPlanId,
      flightAssignmentId,
      tenantId,
      event: "FlightStatusUpdated",
      status: transitionResult.currentState
    });

    return sendSuccess(res, 200, "Flight status updated successfully.", flight, requestId);
  } catch (err) {
    console.error("UpdateFlightExecutionStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to update flight status.", requestId);
  }
};

/**
 * 6. POST /api/v1/travel-plans/:travelPlanId/flights/:flightAssignmentId/incidents
 * Reports a flight incident (e.g. Missed flight, lost baggage, medical emergency).
 */
export const ReportFlightIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, flightAssignmentId } = req.params;
    const { incidentType, severity, description, resolution } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!incidentType || !description) {
      return sendError(res, 400, "incidentType and description are required.", requestId);
    }

    // "Incident Severity" — validated up front against the real config list
    // rather than letting a bad value fall through to a generic 500 from
    // Mongoose's own enum validation.
    if (severity && !flightConfig.incidentSeverities.includes(severity)) {
      return sendError(res, 400, `Invalid severity '${severity}'. Must be one of: ${flightConfig.incidentSeverities.join(", ")}.`, requestId);
    }

    const flight = await TravelFlightAssignmentModel.findOne({ _id: flightAssignmentId, travelPlanId, ...scope });
    if (!flight) {
      return sendError(res, 404, "Flight assignment not found.", requestId);
    }

    const incident = {
      incidentType,
      severity: severity || "Medium",
      description,
      reportedAt: new Date(),
      reportedBy: req.auth?.name || userId || "Staff",
      resolution: resolution || null
    };

    flight.incidents.push(incident);
    await flight.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "FlightIncidentReported",
      title: `Flight Incident: ${incidentType}`,
      description: `[Severity: ${incident.severity}] ${description}`,
      performedBy: userId,
      metadata: incident
    });

    publishEvent("FlightIncidentReported", {
      travelPlanId,
      flightAssignmentId,
      incidentType,
      severity: incident.severity,
      tenantId
    });

    return sendSuccess(res, 201, "Flight incident reported successfully.", incident, requestId);
  } catch (err) {
    console.error("ReportFlightIncident Error:", err);
    return sendError(res, 500, err.message || "Failed to report flight incident.", requestId);
  }
};
