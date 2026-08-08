import mongoose from "mongoose";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import TravelHotelAssignmentModel from "../models/TravelHotelAssignmentModel.js";
import TravelTransportAssignmentModel from "../models/TravelTransportAssignmentModel.js";
import TravelAttendanceModel from "../models/TravelAttendanceModel.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import BookingTravelerModel from "../models/BookingTravelerModel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getTravelConfig } from "../utils/travelConfig.js";
import { getAllowedNextActions, executeWorkflowTransition } from "../utils/WorkflowEngine.js";
import SearchEngineService from "../services/SearchEngineService.js";
import { getAccessScope, applyOptionalBranchFilter } from "../utils/accessScope.js";

const travelConfig = getTravelConfig();

// Helper: Record Travel Timeline Event
const recordTravelTimeline = async ({ travelPlanId, tenantId, eventType, title, description, performedBy = null, performedByName = null, metadata = {} }) => {
  try {
    await TravelTimelineModel.create({
      travelPlanId,
      tenantId,
      module: "TravelOperations",
      eventType,
      title: title || eventType,
      description: description || title || eventType,
      performedBy,
      performedByName: performedByName || "System",
      metadata
    });
  } catch (err) {
    console.error("recordTravelTimeline error:", err);
  }
};

// Helper: Build DTO for Travel Plan List
const buildTravelPlanDTO = (tp) => {
  return {
    travelPlanId: tp._id,
    travelPlanNumber: tp.travelPlanNumber,
    bookingId: tp.bookingId,
    bookingNumber: tp.bookingNumber,
    travelType: tp.travelType ? (tp.travelType.charAt(0).toUpperCase() + tp.travelType.slice(1)) : "Umrah",
    departureDate: tp.departureDate ? tp.departureDate.toISOString().split("T")[0] : null,
    arrivalDate: tp.arrivalDate ? tp.arrivalDate.toISOString().split("T")[0] : null,
    travelerCount: Array.isArray(tp.travelerSnapshots) ? tp.travelerSnapshots.length : 0,
    status: tp.status ? (tp.status.charAt(0).toUpperCase() + tp.status.slice(1)) : "Planning",
    coordinator: tp.coordinator || "Unassigned",
    priority: tp.priority || "normal",
    isArchived: tp.isArchived || false,
    version: tp.version || 1,
    createdAt: tp.createdAt
  };
};

/**
 * 1. GET /api/v1/travel-plans
 * Returns a paginated list of travel plans for the authenticated tenant.
 */
export const ListTravelPlans = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "20", 10), 1), 100);

    const filter = applyOptionalBranchFilter(scope, req.query.branchId);

    // Default to excluding archived plans unless explicitly requested
    if (req.query.isArchived !== "true") {
      filter.isArchived = false;
    }

    if (req.query.travelStatus || req.query.status) {
      filter.status = (req.query.travelStatus || req.query.status).toLowerCase();
    }

    if (req.query.travelType) {
      filter.travelType = req.query.travelType.toLowerCase();
    }

    if (req.query.bookingId) {
      filter.bookingId = req.query.bookingId;
    }

    if (req.query.assignedCoordinator) {
      filter.travelCoordinatorId = req.query.assignedCoordinator;
    }

    // Date range filters
    if (req.query.departureDateFrom || req.query.departureDateTo) {
      filter.departureDate = {};
      if (req.query.departureDateFrom) {
        filter.departureDate.$gte = new Date(req.query.departureDateFrom);
      }
      if (req.query.departureDateTo) {
        filter.departureDate.$lte = new Date(req.query.departureDateTo);
      }
    }

    if (req.query.arrivalDateFrom || req.query.arrivalDateTo) {
      filter.arrivalDate = {};
      if (req.query.arrivalDateFrom) {
        filter.arrivalDate.$gte = new Date(req.query.arrivalDateFrom);
      }
      if (req.query.arrivalDateTo) {
        filter.arrivalDate.$lte = new Date(req.query.arrivalDateTo);
      }
    }

    // Search query
    const search = req.query.search?.trim() || req.query.q?.trim() || null;
    if (search) {
      filter.$or = [
        { travelPlanNumber: { $regex: search, $options: "i" } },
        { bookingNumber: { $regex: search, $options: "i" } },
        { coordinator: { $regex: search, $options: "i" } },
        { "bookingSnapshot.customerName": { $regex: search, $options: "i" } }
      ];
    }

    const sortField = req.query.sort || "departureDate";
    const sortOrder = req.query.order === "desc" ? -1 : 1;

    const totalItems = await TravelPlanModel.countDocuments(filter);
    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    const plans = await TravelPlanModel.find(filter)
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    const formattedData = plans.map(buildTravelPlanDTO);

    return sendSuccess(res, 200, "Travel plans loaded.", {
      data: formattedData,
      meta: { page, pageSize, totalItems, totalPages }
    }, requestId);
  } catch (err) {
    console.error("ListTravelPlans Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch travel plans.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans
 * Creates a new Travel Plan from a confirmed Booking.
 */
export const CreateTravelPlan = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      bookingId,
      departureDate,
      arrivalDate,
      travelCoordinatorId,
      coordinator,
      travelType,
      priority,
      internalRemarks,
      emergencyContact
    } = req.body;

    if (!bookingId) {
      return sendError(res, 400, "bookingId is required.", requestId);
    }

    if (!departureDate || !arrivalDate) {
      return sendError(res, 400, "departureDate and arrivalDate are required.", requestId);
    }

    const depDate = new Date(departureDate);
    const arrDate = new Date(arrivalDate);

    if (isNaN(depDate.getTime()) || isNaN(arrDate.getTime())) {
      return sendError(res, 400, "Invalid departureDate or arrivalDate format.", requestId);
    }

    if (arrDate <= depDate) {
      return sendError(res, 400, "arrivalDate must be after departureDate.", requestId);
    }

    // 1. Fetch & Validate Booking — tenant-scoped, so a travel plan can
    // never be created off a booking belonging to another tenant.
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, ...scope });
    if (!booking) {
      return sendError(res, 404, "Booking not found or does not belong to tenant.", requestId);
    }

    // Validation Rule: "Booking Confirmed" / Business Rule: "Booking must be
    // confirmed." "partially_paid"/"fully_paid" were dead values here — those
    // are Booking.paymentStatus values, not Booking.status values (Booking's
    // own Workflow Part replaced its status lifecycle; status can never
    // actually equal them). A booking that has progressed further than
    // "confirmed" (deposit received, visa processing, tickets issued,
    // travel-ready) is still eligible — it's confirmed-or-later, not yet
    // traveling/completed/cancelled.
    const allowedBookingStatuses = ["confirmed", "deposit_received", "visa_processing", "ticket_issued", "travel_ready"];
    if (!allowedBookingStatuses.includes(booking.status)) {
      return sendError(res, 400, `Cannot create travel plan for booking in status '${booking.status}'. Booking must be confirmed.`, requestId);
    }

    // 2. Check if active non-archived Travel Plan already exists for this booking
    const existingPlan = await TravelPlanModel.findOne({
      bookingId,
      tenantId,
      isArchived: false,
      status: { $ne: "cancelled" }
    });

    if (existingPlan) {
      return sendError(res, 400, `An active Travel Plan (${existingPlan.travelPlanNumber}) already exists for this booking.`, requestId);
    }

    // Validation Rule: "Coordinator Exists" — mirrors Booking's "Consultant
    // Exists" validation (CreateBooking) against the same EmployeeProfileModel.
    if (travelCoordinatorId) {
      if (!mongoose.Types.ObjectId.isValid(travelCoordinatorId)) {
        return sendError(res, 422, `Coordinator "${travelCoordinatorId}" does not exist.`, requestId);
      }
      const coordinatorRecord = await EmployeeProfileModel.findOne({
        tenantId, status: { $ne: "archived" },
        $or: [{ _id: travelCoordinatorId }, { identityId: travelCoordinatorId }]
      });
      if (!coordinatorRecord) {
        return sendError(res, 422, `Coordinator "${travelCoordinatorId}" does not exist.`, requestId);
      }
    }

    // 3. Copy Traveler Snapshots
    const bookingTravelers = await BookingTravelerModel.find({ bookingId, tenantId });
    const travelerSnapshots = bookingTravelers.map((t) => ({
      travelerId: t._id,
      title: t.title || "",
      firstName: t.firstName || "",
      lastName: t.lastName || "",
      fullName: `${t.firstName || ""} ${t.lastName || ""}`.trim(),
      passportNumber: t.passportNumber || "",
      passportExpiry: t.passportExpiryDate || null,
      gender: t.gender || "",
      dateOfBirth: t.dateOfBirth || null,
      nationality: t.nationality || "",
      phone: t.phone || "",
      roomPreference: t.roomPreference || "",
      specialRequests: t.specialNotes || ""
    }));

    // 4. Generate Travel Plan Number (e.g., TP-2026-XXXXX)
    const count = await TravelPlanModel.countDocuments({ tenantId });
    const year = new Date().getFullYear();
    const sequenceStr = String(count + 1).padStart(5, "0");
    const travelPlanNumber = `TP-${year}-${sequenceStr}`;

    // 5. Default Operational Checklists
    const defaultChecklists = [
      { title: "Flight Tickets Issued", isCompleted: false },
      { title: "Hotel Vouchers Confirmed", isCompleted: false },
      { title: "Visa Clearances Verified", isCompleted: false },
      { title: "Ground Transportation Scheduled", isCompleted: false },
      { title: "Traveler Passports Verified", isCompleted: false },
      { title: "Emergency Contacts Assigned", isCompleted: false }
    ];

    // 6. Create Travel Plan
    const newTravelPlan = await TravelPlanModel.create({
      tenantId,
      branchId: booking.branchId || req.auth?.branchId || "default",
      travelPlanNumber,
      bookingId: booking._id,
      bookingNumber: booking.bookingNumber || booking.bookingReference,
      bookingSnapshot: {
        bookingReference: booking.bookingReference,
        customerId: booking.customerId,
        customerName: booking.customerName || "N/A",
        customerCode: booking.customerCode || "",
        bookingType: booking.bookingType,
        packageId: booking.packageId,
        totalAmount: booking.totalAmount,
        currency: booking.currency || "USD",
        paymentStatus: booking.paymentStatus,
        visaStatus: booking.visaStatus
      },
      travelerSnapshots,
      travelType: travelType || (booking.bookingType === "hajj" ? "hajj" : "umrah"),
      status: "planning",
      priority: priority || booking.priority || "normal",
      departureDate: depDate,
      arrivalDate: arrDate,
      travelCoordinatorId: travelCoordinatorId || null,
      coordinator: coordinator || null,
      internalRemarks: internalRemarks || null,
      emergencyContact: emergencyContact || { name: null, phone: null, relationship: null },
      checklists: defaultChecklists,
      version: 1,
      versionHistory: [
        {
          version: 1,
          updatedBy: userId || "System",
          updatedAt: new Date(),
          changes: { note: "Initial travel plan created from booking." }
        }
      ]
    });

    // 7. Record Timeline Events
    await recordTravelTimeline({
      travelPlanId: newTravelPlan._id,
      tenantId,
      eventType: "TravelPlanCreated",
      title: "Travel Plan Created",
      description: `Travel plan ${travelPlanNumber} created for booking ${booking.bookingReference}`,
      performedBy: userId,
      performedByName: req.auth?.name || "Staff"
    });

    await recordTravelTimeline({
      travelPlanId: newTravelPlan._id,
      tenantId,
      eventType: "TravelWorkflowInitialized",
      title: "Workflow Initialized",
      description: "Default operational workflow and checklists initialized.",
      performedBy: userId
    });

    if (travelCoordinatorId || coordinator) {
      await recordTravelTimeline({
        travelPlanId: newTravelPlan._id,
        tenantId,
        eventType: "TravelCoordinatorAssigned",
        title: "Coordinator Assigned",
        description: `Assigned coordinator: ${coordinator || travelCoordinatorId}`,
        performedBy: userId
      });
      // Domain Events (Part 2): TravelCoordinatorAssigned — was previously
      // only a timeline log entry, never on the actual event bus.
      publishEvent("TravelCoordinatorAssigned", {
        travelPlanId: newTravelPlan._id,
        tenantId,
        travelCoordinatorId: travelCoordinatorId || null,
        coordinator: coordinator || null
      });
    }

    // 8. Publish Domain Event
    publishEvent("TravelPlanCreated", {
      travelPlanId: newTravelPlan._id,
      travelPlanNumber,
      bookingId: booking._id,
      tenantId,
      coordinatorId: travelCoordinatorId || null
    });

    // 9. Audit Log
    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "CREATE_TRAVEL_PLAN",
        module: "TravelOperations",
        targetId: newTravelPlan._id.toString(),
        details: { travelPlanNumber, bookingId: booking._id }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Travel plan created successfully.", {
      travelPlanId: newTravelPlan._id,
      travelPlanNumber: newTravelPlan.travelPlanNumber,
      status: "Planning",
      departureDate: newTravelPlan.departureDate,
      arrivalDate: newTravelPlan.arrivalDate
    }, requestId);
  } catch (err) {
    console.error("CreateTravelPlan Error:", err);
    return sendError(res, 500, err.message || "Failed to create travel plan.", requestId);
  }
};

/**
 * 3. GET /api/v1/travel-plans/:travelPlanId
 * Returns the complete travel aggregate summary.
 */
export const GetTravelPlan = async (req, res) => {
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

    // Fetch Timeline Summaries
    const timelineEvents = await TravelTimelineModel.find({ travelPlanId, tenantId })
      .sort({ createdAt: -1 })
      .limit(10);

    // Real aggregate sub-collection summaries — these were previously
    // hardcoded to zero/empty regardless of actual data (a "no hardcoding"
    // violation, same bug class as GetBooking's documentsCount/tasksCount
    // fix in the Booking module). Each still points to its own dedicated
    // list endpoint for full detail; this is a lightweight summary only.
    const TERMINAL_INCIDENT_STATUSES = ["resolved", "verified", "closed", "rejected", "duplicate"];
    const CHECKED_IN_ATTENDANCE_STATUSES = ["Present", "Checked In", "Checked Out", "Late"];

    const [flights, hotels, transports, totalCheckins, openIncidentCount, totalIncidentCount, incidentsWithTasks] = await Promise.all([
      TravelFlightAssignmentModel.find({ travelPlanId, tenantId }).select("airline flightNumber plannedDeparture plannedArrival status").sort({ plannedDeparture: 1 }).lean(),
      TravelHotelAssignmentModel.find({ travelPlanId, tenantId }).select("hotelName city plannedCheckIn plannedCheckOut status").sort({ plannedCheckIn: 1 }).lean(),
      TravelTransportAssignmentModel.find({ travelPlanId, tenantId }).select("transportType journeySegment plannedDeparture status").sort({ plannedDeparture: 1 }).lean(),
      TravelAttendanceModel.countDocuments({ travelPlanId, tenantId, status: { $in: CHECKED_IN_ATTENDANCE_STATUSES } }),
      TravelIncidentManagementModel.countDocuments({ travelPlanId, tenantId, status: { $nin: TERMINAL_INCIDENT_STATUSES } }),
      TravelIncidentManagementModel.countDocuments({ travelPlanId, tenantId }),
      // "Task Summary" — there is no standalone Travel Task model (no
      // dedicated Task Management Part exists in this doc's own Progress
      // checklist); the only real task data in this module is the tasks[]
      // embedded on incidents (models/TravelIncidentManagementModel.js).
      // Summarized from that real data rather than fabricating a subsystem.
      TravelIncidentManagementModel.find({ travelPlanId, tenantId }).select("tasks").lean()
    ]);

    const allTasks = incidentsWithTasks.flatMap((incident) => incident.tasks || []);

    const responseAggregate = {
      header: {
        travelPlanId: travelPlan._id,
        travelPlanNumber: travelPlan.travelPlanNumber,
        tenantId: travelPlan.tenantId,
        branchId: travelPlan.branchId,
        travelType: travelPlan.travelType,
        status: travelPlan.status,
        priority: travelPlan.priority,
        departureDate: travelPlan.departureDate,
        arrivalDate: travelPlan.arrivalDate,
        coordinator: travelPlan.coordinator,
        travelCoordinatorId: travelPlan.travelCoordinatorId,
        assignedTeam: travelPlan.assignedTeam,
        emergencyContact: travelPlan.emergencyContact,
        internalRemarks: travelPlan.internalRemarks,
        isArchived: travelPlan.isArchived,
        version: travelPlan.version,
        createdAt: travelPlan.createdAt,
        updatedAt: travelPlan.updatedAt
      },
      bookingSummary: travelPlan.bookingSnapshot,
      travelerSummary: {
        totalTravelers: travelPlan.travelerSnapshots ? travelPlan.travelerSnapshots.length : 0,
        travelers: travelPlan.travelerSnapshots
      },
      flightSummary: {
        count: flights.length,
        flights
      },
      hotelSummary: {
        count: hotels.length,
        hotels
      },
      transportSummary: {
        count: transports.length,
        transports
      },
      checklistSummary: {
        total: travelPlan.checklists ? travelPlan.checklists.length : 0,
        completed: travelPlan.checklists ? travelPlan.checklists.filter((c) => c.isCompleted).length : 0,
        checklists: travelPlan.checklists
      },
      attendanceSummary: {
        totalCheckins,
        status: totalCheckins > 0 ? (totalCheckins >= (travelPlan.travelerSnapshots?.length || 0) ? "Complete" : "In Progress") : "Pending"
      },
      incidentSummary: {
        openIncidents: openIncidentCount,
        totalIncidents: totalIncidentCount
      },
      taskSummary: {
        total: allTasks.length,
        completed: allTasks.filter((t) => t.isCompleted).length,
        pending: allTasks.filter((t) => !t.isCompleted).length
      },
      workflowSummary: {
        currentStatus: travelPlan.status,
        // Real, state-aware transitions from utils/WorkflowEngine.js's
        // "travelplan" branch (utils/travelConfig.js) — was previously a
        // hardcoded literal array returned regardless of actual status.
        availableTransitions: getAllowedNextActions(travelPlan.status, "TravelPlan")
      },
      timelineSummary: timelineEvents,
      versionHistory: travelPlan.versionHistory
    };

    return sendSuccess(res, 200, "Travel plan retrieved successfully.", responseAggregate, requestId);
  } catch (err) {
    console.error("GetTravelPlan Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch travel plan.", requestId);
  }
};

/**
 * 4. PATCH /api/v1/travel-plans/:travelPlanId
 * Updates operational planning information & tracks versions.
 */
export const UpdateTravelPlan = async (req, res) => {
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

    if (travelPlan.status === "completed" || travelPlan.status === "archived") {
      return sendError(res, 400, `Cannot update travel plan in '${travelPlan.status}' status. Completed or archived plans cannot be modified.`, requestId);
    }

    // Disallowed fields
    const disallowedFields = ["travelPlanNumber", "bookingId", "tenantId", "createdAt", "travelerSnapshots"];
    for (const field of disallowedFields) {
      if (req.body[field] !== undefined) {
        return sendError(res, 400, `Field '${field}' cannot be updated directly.`, requestId);
      }
    }

    // Part 2's editable-fields list is the authoritative contract for this
    // endpoint: Travel Coordinator, Departure Time, Arrival Time, Priority,
    // Internal Remarks, Assigned Team, Emergency Contact. "travelType" and
    // "checklists" were previously accepted too, despite neither being in
    // that list (mirrors Booking Part 2 trimming UpdateBooking's editable
    // fields to match its own doc-authoritative list exactly). Checklist-item
    // completion has no documented endpoint anywhere in this doc so far —
    // flagged, not silently left as an undocumented side door here.
    const editableFields = [
      "departureDate",
      "arrivalDate",
      "travelCoordinatorId",
      "coordinator",
      "priority",
      "internalRemarks",
      "assignedTeam",
      "emergencyContact"
    ];

    // Business Rule: "Critical changes require approval." Mirrors Booking
    // Part 2's "confirmed bookings require approval for critical field
    // changes" gate: once a plan is past "planning" (i.e. operationally
    // locked in), schedule/coordinator changes need elevated permission.
    const criticalFields = ["departureDate", "arrivalDate", "travelCoordinatorId", "coordinator"];
    const touchesCriticalField = criticalFields.some((key) => req.body[key] !== undefined);
    if (touchesCriticalField && travelPlan.status !== "planning") {
      if (!permissions.includes("admin")) {
        return sendError(res, 403, `Elevated permission required to change schedule/coordinator fields on a travel plan in '${travelPlan.status}' status.`, requestId);
      }
    }

    // Validation Rule: "Coordinator Exists" — same check as CreateTravelPlan.
    if (req.body.travelCoordinatorId !== undefined && req.body.travelCoordinatorId !== null) {
      if (!mongoose.Types.ObjectId.isValid(req.body.travelCoordinatorId)) {
        return sendError(res, 422, `Coordinator "${req.body.travelCoordinatorId}" does not exist.`, requestId);
      }
      const coordinatorRecord = await EmployeeProfileModel.findOne({
        tenantId, status: { $ne: "archived" },
        $or: [{ _id: req.body.travelCoordinatorId }, { identityId: req.body.travelCoordinatorId }]
      });
      if (!coordinatorRecord) {
        return sendError(res, 422, `Coordinator "${req.body.travelCoordinatorId}" does not exist.`, requestId);
      }
    }

    const changes = {};
    let scheduleChanged = false;
    let coordinatorChanged = false;

    editableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        if (field === "departureDate" || field === "arrivalDate") {
          const newDate = new Date(req.body[field]);
          if (!isNaN(newDate.getTime())) {
            changes[field] = newDate;
            scheduleChanged = true;
          }
        } else if (field === "travelCoordinatorId" || field === "coordinator") {
          changes[field] = req.body[field];
          coordinatorChanged = true;
        } else {
          changes[field] = req.body[field];
        }
      }
    });

    // Status changes are no longer a raw field write — "status" jumping
    // straight to any enum value with zero transition-validity checking
    // was the same "workflow bypass" bug class found (and fixed) in
    // Booking's CancelBooking. Both an explicit action name and a bare
    // targetState (legacy "status") are accepted; executeWorkflowTransition
    // resolves either against utils/travelConfig.js's real transition table.
    let transitionResult = null;
    if (req.body.action || req.body.status) {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "TravelPlan",
        entityId: travelPlan._id,
        action: req.body.action || null,
        targetState: req.body.status || null,
        performedBy: userId,
        performedByName: req.auth?.name || "Staff",
        userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : []),
        comments: req.body.comments || null
      }).catch((transitionErr) => {
        const wrapped = new Error(transitionErr.message);
        wrapped.statusCode = 400;
        throw wrapped;
      });

      if (transitionResult.requiresApproval) {
        return sendSuccess(res, 202, transitionResult.message, {
          currentState: transitionResult.currentState,
          requiresApproval: true,
          approvalRole: transitionResult.approvalRole
        }, requestId);
      }

      changes.status = transitionResult.currentState;
    }

    if (Object.keys(changes).length === 0) {
      return sendError(res, 400, "No valid fields provided for update.", requestId);
    }

    // Apply changes
    Object.assign(travelPlan, changes);

    // Versioning logic (Senior Architect Recommendation)
    travelPlan.version = (travelPlan.version || 1) + 1;
    travelPlan.versionHistory.push({
      version: travelPlan.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await travelPlan.save();

    // Timeline logging
    await recordTravelTimeline({
      travelPlanId: travelPlan._id,
      tenantId,
      eventType: "TravelPlanUpdated",
      title: "Travel Plan Updated",
      description: `Updated fields: ${Object.keys(changes).join(", ")} (Version v${travelPlan.version})`,
      performedBy: userId,
      performedByName: req.auth?.name || "Staff",
      metadata: changes
    });

    if (scheduleChanged) {
      await recordTravelTimeline({
        travelPlanId: travelPlan._id,
        tenantId,
        eventType: "TravelScheduleUpdated",
        title: "Schedule Updated",
        description: `New dates - Dep: ${travelPlan.departureDate}, Arr: ${travelPlan.arrivalDate}`,
        performedBy: userId
      });
      // Domain Events (Part 2): TravelScheduleUpdated — was previously only
      // a timeline log entry, never on the actual event bus.
      publishEvent("TravelScheduleUpdated", {
        travelPlanId: travelPlan._id,
        tenantId,
        departureDate: travelPlan.departureDate,
        arrivalDate: travelPlan.arrivalDate
      });
    }

    if (coordinatorChanged) {
      await recordTravelTimeline({
        travelPlanId: travelPlan._id,
        tenantId,
        eventType: "TravelCoordinatorChanged",
        title: "Coordinator Changed",
        description: `New coordinator: ${travelPlan.coordinator || travelPlan.travelCoordinatorId}`,
        performedBy: userId
      });
      // Domain Events (Part 2): TravelCoordinatorChanged — was previously
      // only a timeline log entry, never on the actual event bus.
      publishEvent("TravelCoordinatorChanged", {
        travelPlanId: travelPlan._id,
        tenantId,
        travelCoordinatorId: travelPlan.travelCoordinatorId,
        coordinator: travelPlan.coordinator
      });
    }

    if (transitionResult) {
      await recordTravelTimeline({
        travelPlanId: travelPlan._id,
        tenantId,
        eventType: "TravelWorkflowTransitionCompleted",
        title: "Workflow Transition Completed",
        description: `Travel plan moved from ${transitionResult.previousState} to ${transitionResult.currentState} via '${transitionResult.actionPerformed}'`,
        performedBy: userId
      });
      publishEvent("TravelPlanStatusChanged", {
        travelPlanId: travelPlan._id,
        tenantId,
        previousState: transitionResult.previousState,
        newStatus: travelPlan.status
      });

      // Named milestone event distinct from the generic StatusChanged —
      // downstream consumers (e.g. an AI Assistant summarizing "trips that
      // wrapped up today") shouldn't have to filter every status transition
      // just to catch completions.
      if (travelPlan.status === "completed") {
        publishEvent("TravelPlanCompleted", {
          travelPlanId: travelPlan._id,
          travelPlanNumber: travelPlan.travelPlanNumber,
          tenantId
        });
      }
    }

    // Event bus
    publishEvent("TravelPlanUpdated", {
      travelPlanId: travelPlan._id,
      travelPlanNumber: travelPlan.travelPlanNumber,
      tenantId,
      version: travelPlan.version
    });

    // Audit log
    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "UPDATE_TRAVEL_PLAN",
        module: "TravelOperations",
        targetId: travelPlan._id.toString(),
        details: { changes, version: travelPlan.version }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Travel plan updated successfully.", buildTravelPlanDTO(travelPlan), requestId);
  } catch (err) {
    console.error("UpdateTravelPlan Error:", err);
    return sendError(res, err.statusCode || 500, err.message || "Failed to update travel plan.", requestId);
  }
};

/**
 * 5. POST /api/v1/travel-plans/:travelPlanId/archive
 * Archives completed travel plans without deleting historical data.
 */
export const ArchiveTravelPlan = async (req, res) => {
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

    if (travelPlan.isArchived) {
      return sendError(res, 400, "Travel plan is already archived.", requestId);
    }

    travelPlan.isArchived = true;
    travelPlan.status = "archived";
    travelPlan.version = (travelPlan.version || 1) + 1;
    travelPlan.versionHistory.push({
      version: travelPlan.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { isArchived: true, status: "archived" }
    });

    await travelPlan.save();

    await recordTravelTimeline({
      travelPlanId: travelPlan._id,
      tenantId,
      eventType: "TravelPlanArchived",
      title: "Travel Plan Archived",
      description: `Travel plan ${travelPlan.travelPlanNumber} has been archived.`,
      performedBy: userId,
      performedByName: req.auth?.name || "Staff"
    });

    publishEvent("TravelPlanArchived", {
      travelPlanId: travelPlan._id,
      travelPlanNumber: travelPlan.travelPlanNumber,
      tenantId
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ARCHIVE_TRAVEL_PLAN",
        module: "TravelOperations",
        targetId: travelPlan._id.toString(),
        details: { travelPlanNumber: travelPlan.travelPlanNumber }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Travel plan archived successfully.", {
      travelPlanId: travelPlan._id,
      travelPlanNumber: travelPlan.travelPlanNumber,
      status: "Archived",
      isArchived: true
    }, requestId);
  } catch (err) {
    console.error("ArchiveTravelPlan Error:", err);
    return sendError(res, 500, err.message || "Failed to archive travel plan.", requestId);
  }
};

/**
 * 6. POST /api/v1/travel-plans/:travelPlanId/travelers
 * Adds travelers to an existing Travel Plan. Part 1's API inventory lists
 * this endpoint, but travelerSnapshots was previously only ever populated
 * once at CreateTravelPlan time with no way to add/update travelers on an
 * existing plan (e.g. a traveler added to the booking after the travel plan
 * was already created). Resolves real BookingTravelerModel records — same
 * source CreateTravelPlan itself reads from — not a hand-typed traveler shape.
 */
export const AddTravelPlanTravelers = async (req, res) => {
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

    if (travelPlan.status === "completed" || travelPlan.status === "archived" || travelPlan.status === "cancelled") {
      return sendError(res, 400, `Cannot add travelers to a travel plan in '${travelPlan.status}' status.`, requestId);
    }

    const { bookingTravelerIds } = req.body;
    if (!Array.isArray(bookingTravelerIds) || bookingTravelerIds.length === 0) {
      return sendError(res, 400, "bookingTravelerIds must be a non-empty array.", requestId);
    }

    const existingTravelerIds = new Set((travelPlan.travelerSnapshots || []).map((t) => `${t.travelerId}`));
    const newIds = bookingTravelerIds.filter((id) => !existingTravelerIds.has(`${id}`));

    if (newIds.length === 0) {
      return sendError(res, 400, "All provided travelers are already part of this travel plan.", requestId);
    }

    // Resolved from the booking the travel plan belongs to, not an arbitrary
    // tenant-wide lookup — a traveler must actually belong to this plan's
    // booking to be added.
    const bookingTravelers = await BookingTravelerModel.find({
      _id: { $in: newIds },
      bookingId: travelPlan.bookingId,
      tenantId
    });

    if (bookingTravelers.length === 0) {
      return sendError(res, 404, "None of the provided travelers were found on this travel plan's booking.", requestId);
    }

    const newSnapshots = bookingTravelers.map((t) => ({
      travelerId: t._id,
      title: t.title || "",
      firstName: t.firstName || "",
      lastName: t.lastName || "",
      fullName: `${t.firstName || ""} ${t.lastName || ""}`.trim(),
      passportNumber: t.passportNumber || "",
      passportExpiry: t.passportExpiryDate || null,
      gender: t.gender || "",
      dateOfBirth: t.dateOfBirth || null,
      nationality: t.nationality || "",
      phone: t.phone || "",
      roomPreference: t.roomPreference || "",
      specialRequests: t.specialNotes || ""
    }));

    travelPlan.travelerSnapshots.push(...newSnapshots);
    travelPlan.version = (travelPlan.version || 1) + 1;
    travelPlan.versionHistory.push({
      version: travelPlan.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes: { travelersAdded: newSnapshots.map((s) => s.travelerId) }
    });

    await travelPlan.save();

    await recordTravelTimeline({
      travelPlanId: travelPlan._id,
      tenantId,
      eventType: "TravelerAddedToTravelPlan",
      title: "Traveler(s) Added",
      description: `${newSnapshots.length} traveler(s) added to travel plan ${travelPlan.travelPlanNumber}`,
      performedBy: userId,
      performedByName: req.auth?.name || "Staff"
    });

    publishEvent("TravelerAddedToTravelPlan", {
      travelPlanId: travelPlan._id,
      tenantId,
      count: newSnapshots.length,
      travelerIds: newSnapshots.map((s) => s.travelerId)
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_TRAVEL_PLAN_TRAVELERS",
        module: "TravelOperations",
        targetId: travelPlan._id.toString(),
        details: { addedCount: newSnapshots.length }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Traveler(s) added successfully.", {
      travelPlanId: travelPlan._id,
      totalTravelers: travelPlan.travelerSnapshots.length,
      addedTravelers: newSnapshots
    }, requestId);
  } catch (err) {
    console.error("AddTravelPlanTravelers Error:", err);
    return sendError(res, 500, err.message || "Failed to add travelers.", requestId);
  }
};

/**
 * 7. GET /api/v1/travel-plans/search
 * Part 1's API inventory lists this endpoint; it never existed despite
 * TravelOrchestrationEngine already indexing every Travel Plan into
 * SearchEngineService's SearchIndexModel on creation. This is a thin read
 * wrapper around that existing index (SearchEngineService.globalSearch,
 * already used the same way for Visa/Customer/Document search), not a new
 * ad-hoc implementation.
 */
export const SearchTravelPlans = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const query = req.query.q?.trim() || req.query.query?.trim() || req.query.search?.trim() || "";
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || String(travelConfig.defaultPageSize), 10), 1), travelConfig.maxPageSize);

    // branchId is an optional, descriptive narrowing filter only — every
    // tenant user can already search every branch's travel plans.
    const { results, meta } = await SearchEngineService.globalSearch({
      tenantId: scope.tenantId,
      query,
      entityType: "TravelPlan",
      branchId: scope.branchId || req.query.branchId || null,
      permissions,
      page,
      pageSize
    });

    return sendSuccess(res, 200, "Travel plan search results.", { data: results, meta }, requestId);
  } catch (err) {
    console.error("SearchTravelPlans Error:", err);
    return sendError(res, 500, err.message || "Failed to search travel plans.", requestId);
  }
};
