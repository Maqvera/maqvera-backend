import mongoose from "mongoose";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTransportAssignmentModel from "../models/TravelTransportAssignmentModel.js";
import FleetResourceModel from "../models/FleetResourceModel.js";
import RouteCatalogModel from "../models/RouteCatalogModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getTransportConfig } from "../utils/transportConfig.js";
import { getAllowedNextActions, executeWorkflowTransition } from "../utils/WorkflowEngine.js";
import { getAccessScope } from "../utils/accessScope.js";

const transportConfig = getTransportConfig();

// Helper for timeline logging
const recordTravelTimeline = async ({ travelPlanId, tenantId, eventType, title, description, performedBy = null, metadata = {} }) => {
  try {
    await TravelTimelineModel.create({
      travelPlanId,
      tenantId,
      module: "TransportManagement",
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
 * 1. GET /api/v1/travel-plans/:travelPlanId/transport
 * Returns all transport assignments and journey segments for a travel plan.
 */
export const ListTravelPlanTransports = async (req, res) => {
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
    const totalItems = await TravelTransportAssignmentModel.countDocuments(filter);
    const transports = await TravelTransportAssignmentModel.find(filter)
      .sort({ plannedDeparture: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    const formattedTransports = transports.map((t) => ({
      transportAssignmentId: t._id,
      travelPlanId: t.travelPlanId,
      transportType: t.transportType,
      journeySegment: t.journeySegment,
      vehicle: {
        fleetResourceId: t.fleetResourceId,
        vehicleNumber: t.vehicleNumber,
        plateNumber: t.plateNumber,
        vehicleType: t.vehicleType,
        capacity: t.capacity
      },
      driver: {
        driverId: t.driverId,
        driverName: t.driverName,
        driverPhone: t.driverPhone
      },
      route: {
        routeCatalogId: t.routeCatalogId,
        routeName: t.routeName,
        pickupLocation: t.pickupLocation,
        dropoffLocation: t.dropoffLocation
      },
      plannedDeparture: t.plannedDeparture,
      plannedArrival: t.plannedArrival,
      actualDeparture: t.actualDeparture,
      actualArrival: t.actualArrival,
      status: t.status,
      priority: t.priority,
      assignedTravelersCount: t.assignedTravelers ? t.assignedTravelers.length : 0,
      assignedTravelers: t.assignedTravelers,
      incidentsCount: t.incidents ? t.incidents.length : 0,
      incidents: t.incidents,
      remarks: t.remarks,
      internalNotes: t.internalNotes,
      availableTransitions: getAllowedNextActions(t.status, "Transport"),
      createdAt: t.createdAt
    }));

    return sendSuccess(res, 200, "Transport assignments retrieved successfully.", {
      data: formattedTransports,
      meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) || 1 }
    }, requestId);
  } catch (err) {
    console.error("ListTravelPlanTransports Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch transport assignments.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans/:travelPlanId/transport
 * Assigns transport resources & journey segment to a travel plan with availability validation.
 */
export const AddTravelPlanTransport = async (req, res) => {
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
      return sendError(res, 400, `Cannot assign transport to a travel plan in '${travelPlan.status}' status.`, requestId);
    }

    const {
      transportType = "Airport Transfer",
      routeCatalogId: routeCatalogIdInput,
      routeId,
      pickupLocation,
      dropoffLocation,
      plannedDeparture,
      plannedArrival,
      priority = "normal",
      remarks = null,
      internalNotes = null
    } = req.body;
    // Doc's request example uses "vehicleId"/"routeId"; fleetResourceId/
    // routeCatalogId are the real field names — both accepted.
    const fleetResourceId = req.body.fleetResourceId || req.body.vehicleId || null;
    const routeCatalogId = routeCatalogIdInput || routeId || null;

    if (!plannedDeparture || !plannedArrival) {
      return sendError(res, 400, "plannedDeparture and plannedArrival are required.", requestId);
    }

    const depDate = new Date(plannedDeparture);
    const arrDate = new Date(plannedArrival);

    if (isNaN(depDate.getTime()) || isNaN(arrDate.getTime())) {
      return sendError(res, 400, "Invalid plannedDeparture or plannedArrival format.", requestId);
    }

    if (arrDate <= depDate) {
      return sendError(res, 400, "plannedArrival must be after plannedDeparture.", requestId);
    }

    // "Transport Architecture: Fleet Catalog -> Vehicle Assignment -> Driver
    // Assignment" / AI Coding Rule "Separate Fleet Catalog." The primary
    // documented flow resolves real vehicle+driver identity from the fleet
    // catalog via vehicleId — this used to silently fall back to an entirely
    // fabricated vehicle AND driver (including a fake driver name and phone
    // number: "Tariq Mahmood" / "+966501234567") whenever those fields were
    // omitted — the single most severe STEP 3 violation found across the
    // whole Travel module. FleetResourceModel already combines vehicle and
    // driver into one resource (no separate Driver catalog exists in this
    // codebase), so "Vehicle Exists"/"Driver Active" resolve together here.
    if (!fleetResourceId) {
      return sendError(res, 400, "vehicleId (fleetResourceId) is required — no ad-hoc vehicle/driver entry is supported; register the vehicle in the fleet catalog first.", requestId);
    }
    if (!mongoose.Types.ObjectId.isValid(fleetResourceId)) {
      return sendError(res, 422, `Vehicle "${fleetResourceId}" does not exist.`, requestId);
    }
    const fleetResource = await FleetResourceModel.findOne({ _id: fleetResourceId, tenantId });
    if (!fleetResource) {
      return sendError(res, 422, `Vehicle "${fleetResourceId}" does not exist.`, requestId);
    }
    // Validation Rules: "Vehicle Active" / "Driver Active" — the fleet
    // resource bundles both, so one status check covers both rules.
    if (["maintenance", "out_of_service"].includes(fleetResource.status)) {
      return sendError(res, 422, `Vehicle "${fleetResource.vehicleNumber}" is currently '${fleetResource.status}' and cannot be assigned.`, requestId);
    }

    const vehicleNumber = fleetResource.vehicleNumber;
    const plateNumber = fleetResource.plateNumber;
    const vehicleType = fleetResource.vehicleType;
    const capacity = fleetResource.capacity;
    const driverId = req.body.driverId || fleetResource._id.toString();
    const driverName = fleetResource.driverName;
    const driverPhone = fleetResource.driverPhone;

    // Route is optional — a simple point-to-point transfer doesn't need a
    // cataloged route, but pickupLocation/dropoffLocation are always
    // required regardless (Response Includes lists both as real fields).
    let routeName = null;
    if (routeCatalogId) {
      if (!mongoose.Types.ObjectId.isValid(routeCatalogId)) {
        return sendError(res, 422, `Route "${routeCatalogId}" does not exist or is inactive.`, requestId);
      }
      const route = await RouteCatalogModel.findOne({ _id: routeCatalogId, tenantId, isActive: true });
      if (!route) {
        return sendError(res, 422, `Route "${routeCatalogId}" does not exist or is inactive.`, requestId);
      }
      routeName = route.routeName;
    }

    if (!pickupLocation || !dropoffLocation) {
      return sendError(res, 400, "pickupLocation and dropoffLocation are required.", requestId);
    }

    const journeySegment = req.body.journeySegment || `${pickupLocation} to ${dropoffLocation}`;

    // Validation Rule: "No Scheduling Conflict" / Business Rules: "Vehicle
    // cannot be double-booked. Driver cannot be assigned to overlapping
    // trips." The overlap query was previously incomplete — it only caught
    // cases where an EXISTING trip's departure or arrival fell strictly
    // inside the new trip's window, missing the case where the new trip is
    // entirely nested inside (or exactly wraps) an existing one. Standard
    // interval-overlap test instead: two intervals overlap iff
    // existing.start < new.end AND existing.end > new.start.
    const vehicleConflict = await TravelTransportAssignmentModel.findOne({
      tenantId,
      vehicleNumber,
      status: { $nin: ["completed", "cancelled"] },
      plannedDeparture: { $lt: arrDate },
      plannedArrival: { $gt: depDate }
    });

    if (vehicleConflict) {
      return sendError(res, 400, `Vehicle '${vehicleNumber}' has a scheduling conflict with another active trip (${vehicleConflict._id}).`, requestId);
    }

    const driverConflict = await TravelTransportAssignmentModel.findOne({
      tenantId,
      driverId,
      status: { $nin: ["completed", "cancelled"] },
      plannedDeparture: { $lt: arrDate },
      plannedArrival: { $gt: depDate }
    });

    if (driverConflict) {
      return sendError(res, 400, `Driver '${driverName}' (ID: ${driverId}) has an overlapping trip assignment.`, requestId);
    }

    const transportAssignment = await TravelTransportAssignmentModel.create({
      travelPlanId,
      tenantId,
      transportType,
      journeySegment,
      fleetResourceId: fleetResource._id,
      vehicleNumber,
      plateNumber,
      vehicleType,
      capacity,
      driverId,
      driverName,
      driverPhone,
      routeCatalogId: routeCatalogId || null,
      routeName: routeName || `${pickupLocation} to ${dropoffLocation}`,
      pickupLocation,
      dropoffLocation,
      plannedDeparture: depDate,
      plannedArrival: arrDate,
      status: "vehicle_assigned",
      priority,
      remarks,
      internalNotes,
      version: 1
    });

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TransportAssigned",
      title: "Transport Assigned",
      description: `${transportType} (${journeySegment}) assigned. Vehicle: ${vehicleNumber}, Driver: ${driverName}`,
      performedBy: userId
    });

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "VehicleAssigned",
      title: "Vehicle Assigned",
      description: `Vehicle ${vehicleType} ${vehicleNumber} (Cap: ${capacity}) assigned.`,
      performedBy: userId
    });

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "DriverAssigned",
      title: "Driver Assigned",
      description: `Driver ${driverName} (${driverPhone}) assigned.`,
      performedBy: userId
    });

    publishEvent("TransportAssigned", {
      travelPlanId,
      transportAssignmentId: transportAssignment._id,
      vehicleNumber,
      driverId,
      tenantId
    });
    // Domain Events (Part 5): VehicleAssigned / DriverAssigned — were
    // previously only timeline log entries, never on the actual event bus.
    publishEvent("VehicleAssigned", {
      travelPlanId,
      transportAssignmentId: transportAssignment._id,
      fleetResourceId: fleetResource._id,
      vehicleNumber,
      tenantId
    });
    publishEvent("DriverAssigned", {
      travelPlanId,
      transportAssignmentId: transportAssignment._id,
      driverId,
      driverName,
      tenantId
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_TRANSPORT_ASSIGNMENT",
        module: "TransportManagement",
        targetId: transportAssignment._id.toString(),
        details: { vehicleNumber, driverId }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Transport assignment created successfully.", transportAssignment, requestId);
  } catch (err) {
    console.error("AddTravelPlanTransport Error:", err);
    return sendError(res, 500, err.message || "Failed to add transport assignment.", requestId);
  }
};

/**
 * 3. POST /api/v1/travel-plans/:travelPlanId/transport/:transportAssignmentId/travelers
 * Assigns travelers to a transport journey segment with capacity checks.
 */
export const AssignTravelersToTransport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, transportAssignmentId } = req.params;
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

    const transport = await TravelTransportAssignmentModel.findOne({ _id: transportAssignmentId, travelPlanId, ...scope });
    if (!transport) {
      return sendError(res, 404, "Transport assignment not found.", requestId);
    }

    const currentAssignedCount = transport.assignedTravelers ? transport.assignedTravelers.length : 0;
    const availableSeats = transport.capacity - currentAssignedCount;

    if (travelerIds.length > availableSeats) {
      return sendError(res, 400, `Vehicle capacity exceeded! Capacity: ${transport.capacity}, Currently assigned: ${currentAssignedCount}, Attempting to add: ${travelerIds.length}.`, requestId);
    }

    // Business Rule: "Traveler belongs to travel plan" / "Duplicate
    // assignment prevented." IDs that don't resolve or are already
    // assigned are reported back explicitly instead of silently dropped.
    const existingAssignedIds = transport.assignedTravelers.map((t) => t.travelerId.toString());
    const skippedTravelerIds = [];
    let newlyAssignedCount = 0;

    travelerIds.forEach((tId) => {
      const travelerSnapshot = travelPlan.travelerSnapshots.find((s) => s.travelerId.toString() === tId.toString() || s._id.toString() === tId.toString());
      if (!travelerSnapshot) {
        skippedTravelerIds.push({ travelerId: tId, reason: "Not part of this travel plan." });
        return;
      }
      if (existingAssignedIds.includes(tId.toString())) {
        skippedTravelerIds.push({ travelerId: tId, reason: "Already assigned to this transport." });
        return;
      }
      transport.assignedTravelers.push({
        travelerId: travelerSnapshot.travelerId || travelerSnapshot._id,
        travelerName: travelerSnapshot.fullName || `${travelerSnapshot.firstName} ${travelerSnapshot.lastName}`,
        boardingStatus: "Not Boarded",
        pickupStatus: "Pending",
        dropoffStatus: "Pending",
        seatNumber: null
      });
      newlyAssignedCount++;
    });

    await transport.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TravelerAssignedToTransport",
      title: "Travelers Assigned to Transport",
      description: `Assigned ${newlyAssignedCount} traveler(s) to vehicle ${transport.vehicleNumber} (${transport.journeySegment})`,
      performedBy: userId
    });

    publishEvent("TravelerAssignedToTransport", {
      travelPlanId,
      transportAssignmentId,
      newlyAssignedCount,
      tenantId
    });

    return sendSuccess(res, 200, `${newlyAssignedCount} traveler(s) assigned to transport successfully.`, {
      transport,
      newlyAssignedCount,
      skippedTravelerIds
    }, requestId);
  } catch (err) {
    console.error("AssignTravelersToTransport Error:", err);
    return sendError(res, 500, err.message || "Failed to assign travelers to transport.", requestId);
  }
};

/**
 * 4. PATCH /api/v1/travel-plans/:travelPlanId/transport/:transportAssignmentId/status
 * Updates live transport execution status & actual departure/arrival times.
 */
export const UpdateTransportExecutionStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, transportAssignmentId } = req.params;
    const { status, actualDeparture, actualArrival, action, comments } = req.body;
    // Business Rules: "Supports replacement vehicle. Supports replacement
    // driver." No dedicated PATCH /transport/{id} endpoint exists in this
    // doc's own endpoint inventory (unlike Flight/Hotel, which both have
    // one) — this status endpoint is the only operational-update surface
    // for an existing transport leg, so replacement is supported here,
    // paired with a "Driver Changed"/breakdown-recovery style status move.
    const newFleetResourceId = req.body.newFleetResourceId || req.body.newVehicleId || null;

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

    const transport = await TravelTransportAssignmentModel.findOne({ _id: transportAssignmentId, travelPlanId, ...scope });
    if (!transport) {
      return sendError(res, 404, "Transport assignment not found.", requestId);
    }

    let replacedVehicle = null;
    if (newFleetResourceId) {
      if (!mongoose.Types.ObjectId.isValid(newFleetResourceId)) {
        return sendError(res, 422, `Vehicle "${newFleetResourceId}" does not exist.`, requestId);
      }
      const newFleetResource = await FleetResourceModel.findOne({ _id: newFleetResourceId, tenantId });
      if (!newFleetResource) {
        return sendError(res, 422, `Vehicle "${newFleetResourceId}" does not exist.`, requestId);
      }
      if (["maintenance", "out_of_service"].includes(newFleetResource.status)) {
        return sendError(res, 422, `Vehicle "${newFleetResource.vehicleNumber}" is currently '${newFleetResource.status}' and cannot be assigned.`, requestId);
      }
      replacedVehicle = {
        fromVehicleNumber: transport.vehicleNumber,
        fromDriverName: transport.driverName,
        toVehicleNumber: newFleetResource.vehicleNumber,
        toDriverName: newFleetResource.driverName
      };
      transport.fleetResourceId = newFleetResource._id;
      transport.vehicleNumber = newFleetResource.vehicleNumber;
      transport.plateNumber = newFleetResource.plateNumber;
      transport.vehicleType = newFleetResource.vehicleType;
      transport.capacity = newFleetResource.capacity;
      transport.driverId = req.body.newDriverId || newFleetResource._id.toString();
      transport.driverName = newFleetResource.driverName;
      transport.driverPhone = newFleetResource.driverPhone;
    }

    // "Validate Transition" — was previously a flat membership check with
    // zero transition-validity checking (same "workflow bypass" bug class
    // fixed for Booking/Travel Plan/Flight/Hotel). Now routed through the
    // real, state-aware Transport workflow (utils/transportConfig.js).
    const normalizedStatus = status ? status.toLowerCase() : null;
    let transitionResult;
    try {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "Transport",
        entityId: transport._id,
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
    transport.status = transitionResult.currentState;

    if (actualDeparture) {
      transport.actualDeparture = new Date(actualDeparture);
      changes.actualDeparture = transport.actualDeparture;
    }

    if (actualArrival) {
      transport.actualArrival = new Date(actualArrival);
      changes.actualArrival = transport.actualArrival;
    }

    if (replacedVehicle) {
      changes.vehicleReplacement = replacedVehicle;
    }

    transport.version = (transport.version || 1) + 1;
    transport.versionHistory.push({
      version: transport.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await transport.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TransportStatusUpdated",
      title: `Transport Status: ${transitionResult.currentState.toUpperCase()}`,
      description: `Transport ${transport.journeySegment} (${transport.vehicleNumber}) status updated to '${transitionResult.currentState}' via '${transitionResult.actionPerformed}'`,
      performedBy: userId,
      metadata: { status: transitionResult.currentState, actualDeparture, actualArrival }
    });

    publishEvent("TransportStatusUpdated", {
      travelPlanId,
      transportAssignmentId,
      status: transitionResult.currentState,
      tenantId
    });

    if (replacedVehicle) {
      publishEvent("VehicleAssigned", { travelPlanId, transportAssignmentId, fleetResourceId: transport.fleetResourceId, vehicleNumber: transport.vehicleNumber, tenantId });
      publishEvent("DriverAssigned", { travelPlanId, transportAssignmentId, driverId: transport.driverId, driverName: transport.driverName, tenantId });
      try {
        await AuditLogModel.create({
          tenantId,
          userId,
          action: "REPLACE_TRANSPORT_VEHICLE",
          module: "TransportManagement",
          targetId: transportAssignmentId,
          details: replacedVehicle
        });
      } catch (auditErr) {
        console.error("Audit log error:", auditErr);
      }
    }

    return sendSuccess(res, 200, "Transport execution status updated successfully.", transport, requestId);
  } catch (err) {
    console.error("UpdateTransportExecutionStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to update transport status.", requestId);
  }
};

/**
 * 5. POST /api/v1/travel-plans/:travelPlanId/transport/:transportAssignmentId/incidents
 * Reports transport incidents (Vehicle breakdown, flat tire, heavy traffic, driver illness, accident, etc.).
 */
export const ReportTransportIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, transportAssignmentId } = req.params;
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
    if (severity && !transportConfig.incidentSeverities.includes(severity)) {
      return sendError(res, 400, `Invalid severity '${severity}'. Must be one of: ${transportConfig.incidentSeverities.join(", ")}.`, requestId);
    }

    const transport = await TravelTransportAssignmentModel.findOne({ _id: transportAssignmentId, travelPlanId, ...scope });
    if (!transport) {
      return sendError(res, 404, "Transport assignment not found.", requestId);
    }

    const incident = {
      incidentType,
      severity: severity || "Medium",
      description,
      reportedAt: new Date(),
      reportedBy: req.auth?.name || userId || "Staff",
      resolution: resolution || null
    };

    transport.incidents.push(incident);
    await transport.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TransportIncidentReported",
      title: `Transport Incident: ${incidentType}`,
      description: `[Severity: ${incident.severity}] ${description}`,
      performedBy: userId,
      metadata: incident
    });

    publishEvent("TransportIncidentReported", {
      travelPlanId,
      transportAssignmentId,
      incidentType,
      severity: incident.severity,
      tenantId
    });

    return sendSuccess(res, 201, "Transport incident reported successfully.", incident, requestId);
  } catch (err) {
    console.error("ReportTransportIncident Error:", err);
    return sendError(res, 500, err.message || "Failed to report transport incident.", requestId);
  }
};
