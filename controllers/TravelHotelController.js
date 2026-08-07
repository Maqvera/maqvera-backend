import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelHotelAssignmentModel from "../models/TravelHotelAssignmentModel.js";
import HotelCatalogModel from "../models/HotelCatalogModel.js";
import HotelRoomInventoryModel from "../models/HotelRoomInventoryModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getHotelConfig } from "../utils/hotelConfig.js";
import { getAllowedNextActions, executeWorkflowTransition } from "../utils/WorkflowEngine.js";
import { getAccessScope } from "../utils/accessScope.js";

const hotelConfig = getHotelConfig();

// Helper for timeline logging
const recordTravelTimeline = async ({ travelPlanId, tenantId, eventType, title, description, performedBy = null, metadata = {} }) => {
  try {
    await TravelTimelineModel.create({
      travelPlanId,
      tenantId,
      module: "HotelOperations",
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
 * 1. GET /api/v1/travel-plans/:travelPlanId/hotels
 * Returns all hotels assigned to a travel plan.
 */
export const ListTravelPlanHotels = async (req, res) => {
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
    const totalItems = await TravelHotelAssignmentModel.countDocuments(filter);
    const hotels = await TravelHotelAssignmentModel.find(filter)
      .sort({ plannedCheckIn: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    const formattedHotels = hotels.map((h) => ({
      hotelAssignmentId: h._id,
      travelPlanId: h.travelPlanId,
      hotelName: h.hotelName,
      city: h.city,
      country: h.country,
      starRating: h.starRating,
      supplier: h.supplier,
      plannedCheckIn: h.plannedCheckIn,
      plannedCheckOut: h.plannedCheckOut,
      actualCheckIn: h.actualCheckIn,
      actualCheckOut: h.actualCheckOut,
      numberOfNights: h.numberOfNights,
      mealPlan: h.mealPlan,
      status: h.status,
      priority: h.priority,
      assignedTravelersCount: h.assignedTravelers ? h.assignedTravelers.length : 0,
      assignedTravelers: h.assignedTravelers,
      roomCount: h.rooms ? h.rooms.length : 0,
      rooms: h.rooms,
      incidentsCount: h.incidents ? h.incidents.length : 0,
      incidents: h.incidents,
      remarks: h.remarks,
      internalNotes: h.internalNotes,
      availableTransitions: getAllowedNextActions(h.status, "Hotel"),
      createdAt: h.createdAt
    }));

    return sendSuccess(res, 200, "Hotel assignments retrieved successfully.", {
      data: formattedHotels,
      meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) || 1 }
    }, requestId);
  } catch (err) {
    console.error("ListTravelPlanHotels Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch hotel assignments.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans/:travelPlanId/hotels
 * Assigns hotel(s) to a travel plan.
 */
export const AddTravelPlanHotels = async (req, res) => {
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
      return sendError(res, 400, `Cannot assign hotels to a travel plan in '${travelPlan.status}' status.`, requestId);
    }

    let hotelItems = [];
    if (Array.isArray(req.body.hotels)) {
      hotelItems = req.body.hotels;
    } else if (req.body.hotelName || req.body.plannedCheckIn || req.body.hotelId || req.body.hotelCatalogId) {
      hotelItems = [req.body];
    } else {
      return sendError(res, 400, "Invalid payload. Pass 'hotels' array or hotel details object.", requestId);
    }

    const createdHotels = [];

    for (const item of hotelItems) {
      // Doc's request example uses "hotelId"; hotelCatalogId is the real
      // field name — both accepted.
      const hotelCatalogId = item.hotelCatalogId || item.hotelId || null;
      const { plannedCheckIn, plannedCheckOut, priority = "normal", remarks = null, internalNotes = null } = item;

      if (!plannedCheckIn || !plannedCheckOut) {
        return sendError(res, 400, "plannedCheckIn and plannedCheckOut are required for each hotel.", requestId);
      }

      const checkInDate = new Date(plannedCheckIn);
      const checkOutDate = new Date(plannedCheckOut);

      if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
        return sendError(res, 400, "Invalid plannedCheckIn or plannedCheckOut format.", requestId);
      }

      // Validation Rule: "Check-out > Check-in"
      if (checkOutDate <= checkInDate) {
        return sendError(res, 400, "plannedCheckOut must be after plannedCheckIn.", requestId);
      }

      const mealPlan = item.mealPlan || "Breakfast";
      if (!hotelConfig.mealPlans.includes(mealPlan)) {
        return sendError(res, 400, `Invalid mealPlan '${mealPlan}'. Must be one of: ${hotelConfig.mealPlans.join(", ")}.`, requestId);
      }

      // "Hotel Architecture: Hotel Catalog -> Travel Hotel Assignment" / AI
      // Coding Rule "Hotel Catalog." The primary documented flow resolves
      // real hotel name/city/country/rating/supplier from the catalog via
      // hotelId — this used to silently fall back to a hardcoded fake hotel
      // ("Pullman Zamzam Makkah") whenever those fields were omitted, a
      // direct STEP 3 violation. Ad-hoc entry remains supported (Business
      // Rule "Supports package hotels"), but only with explicit real values.
      let hotelName, city, country, starRating, supplier;

      if (hotelCatalogId) {
        // Validation Rules: "Hotel Exists" / "Hotel Active"
        const catalogEntry = await HotelCatalogModel.findOne({ _id: hotelCatalogId, tenantId, isActive: true });
        if (!catalogEntry) {
          return sendError(res, 422, `Hotel "${hotelCatalogId}" does not exist or is inactive.`, requestId);
        }
        hotelName = catalogEntry.name;
        city = catalogEntry.city;
        country = catalogEntry.country;
        starRating = catalogEntry.starRating;
        supplier = catalogEntry.supplier;
      } else {
        hotelName = item.hotelName;
        city = item.city;
        country = item.country;
        starRating = item.starRating;
        supplier = item.supplier;

        const missingFields = ["hotelName", "city"].filter((f) => !item[f]);
        if (missingFields.length > 0) {
          return sendError(res, 400, `Either provide hotelId (catalog lookup) or all of: ${missingFields.join(", ")} (package hotel).`, requestId);
        }
      }

      const nights = Math.max(Math.round((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24)), 1);

      const hotelAssignment = await TravelHotelAssignmentModel.create({
        travelPlanId,
        tenantId,
        branchId: travelPlan.branchId,
        hotelCatalogId: hotelCatalogId || null,
        hotelName,
        city,
        country: country || "Saudi Arabia",
        starRating: starRating || 5,
        supplier: supplier || "Direct Hotel Contract",
        plannedCheckIn: checkInDate,
        plannedCheckOut: checkOutDate,
        numberOfNights: nights,
        mealPlan,
        status: hotelConfig.defaultHotelStatus,
        priority,
        remarks,
        internalNotes,
        version: 1
      });

      createdHotels.push(hotelAssignment);

      await recordTravelTimeline({
        travelPlanId,
        tenantId,
        eventType: "HotelAssigned",
        title: "Hotel Assigned",
        description: `Hotel ${hotelName} (${city}) assigned from ${plannedCheckIn} to ${plannedCheckOut}`,
        performedBy: userId
      });

      publishEvent("HotelAssigned", {
        travelPlanId,
        hotelAssignmentId: hotelAssignment._id,
        hotelName,
        tenantId
      });
    }

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "HotelWorkflowInitialized",
      title: "Hotel Workflow Initialized",
      description: `Initialized hotel operations workflow for ${createdHotels.length} hotel stay(s).`,
      performedBy: userId
    });
    // Domain Events (Part 4): HotelWorkflowInitialized — was previously
    // only a timeline log entry, never on the actual event bus.
    publishEvent("HotelWorkflowInitialized", {
      travelPlanId,
      tenantId,
      hotelAssignmentIds: createdHotels.map((h) => h._id)
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_HOTEL_ASSIGNMENT",
        module: "HotelOperations",
        targetId: travelPlanId,
        details: { hotelCount: createdHotels.length }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Hotel assignment(s) created successfully.", createdHotels, requestId);
  } catch (err) {
    console.error("AddTravelPlanHotels Error:", err);
    return sendError(res, 500, err.message || "Failed to add hotel assignment.", requestId);
  }
};

/**
 * 3. PATCH /api/v1/travel-plans/:travelPlanId/hotels/:hotelAssignmentId
 * Updates hotel assignment details.
 */
export const UpdateTravelPlanHotel = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, hotelAssignmentId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const hotel = await TravelHotelAssignmentModel.findOne({ _id: hotelAssignmentId, travelPlanId, ...scope });
    if (!hotel) {
      return sendError(res, 404, "Hotel assignment not found.", requestId);
    }

    if (hotel.status === "completed") {
      return sendError(res, 400, "Completed hotel stays are locked and cannot be modified.", requestId);
    }

    if (req.body.mealPlan !== undefined && !hotelConfig.mealPlans.includes(req.body.mealPlan)) {
      return sendError(res, 400, `Invalid mealPlan '${req.body.mealPlan}'. Must be one of: ${hotelConfig.mealPlans.join(", ")}.`, requestId);
    }

    const editableFields = [
      "plannedCheckIn",
      "plannedCheckOut",
      "mealPlan",
      "remarks",
      "priority",
      "internalNotes"
    ];

    let scheduleChanged = false;
    const changes = {};

    editableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        if (field === "plannedCheckIn" || field === "plannedCheckOut") {
          const newDate = new Date(req.body[field]);
          if (!isNaN(newDate.getTime())) {
            changes[field] = newDate;
            scheduleChanged = true;
          }
        } else {
          changes[field] = req.body[field];
        }
      }
    });

    // Editable Field "Assigned Travelers" — hotel.assignedTravelers existed
    // on the schema but nothing ever populated it (room-level travelers[]
    // is a separate, already-working thing). Resolved against the travel
    // plan's real traveler snapshots, same validation pattern used
    // elsewhere in this module.
    if (req.body.assignedTravelers !== undefined) {
      if (!Array.isArray(req.body.assignedTravelers)) {
        return sendError(res, 400, "assignedTravelers must be an array of traveler IDs.", requestId);
      }
      const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
      if (!travelPlan) {
        return sendError(res, 404, "Travel plan not found.", requestId);
      }
      const resolvedTravelers = [];
      for (const tId of req.body.assignedTravelers) {
        const snapshot = travelPlan.travelerSnapshots.find((s) => s.travelerId.toString() === tId.toString() || s._id.toString() === tId.toString());
        if (!snapshot) {
          return sendError(res, 400, `Traveler ID '${tId}' does not belong to this Travel Plan.`, requestId);
        }
        resolvedTravelers.push({
          travelerId: snapshot.travelerId || snapshot._id,
          travelerName: snapshot.fullName || `${snapshot.firstName} ${snapshot.lastName}`
        });
      }
      changes.assignedTravelers = resolvedTravelers;
    }

    if (Object.keys(changes).length === 0) {
      return sendError(res, 400, "No valid fields provided for update.", requestId);
    }

    Object.assign(hotel, changes);

    if (scheduleChanged) {
      const checkIn = new Date(hotel.plannedCheckIn);
      const checkOut = new Date(hotel.plannedCheckOut);
      if (checkOut > checkIn) {
        hotel.numberOfNights = Math.max(Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24)), 1);
      }
    }

    hotel.version = (hotel.version || 1) + 1;
    hotel.versionHistory.push({
      version: hotel.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await hotel.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "HotelUpdated",
      title: "Hotel Updated",
      description: `Hotel ${hotel.hotelName} updated fields: ${Object.keys(changes).join(", ")}`,
      performedBy: userId,
      metadata: changes
    });

    if (scheduleChanged) {
      publishEvent("HotelRescheduled", { travelPlanId, hotelAssignmentId, tenantId });
    }

    publishEvent("HotelUpdated", { travelPlanId, hotelAssignmentId, tenantId });

    // Business Rule: "Audit required." Was previously missing entirely on
    // this endpoint (present on AddTravelPlanHotels, absent here).
    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "UPDATE_HOTEL_ASSIGNMENT",
        module: "HotelOperations",
        targetId: hotelAssignmentId,
        details: { changes: Object.keys(changes), version: hotel.version }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Hotel assignment updated successfully.", hotel, requestId);
  } catch (err) {
    console.error("UpdateTravelPlanHotel Error:", err);
    return sendError(res, 500, err.message || "Failed to update hotel assignment.", requestId);
  }
};

/**
 * 4. POST /api/v1/travel-plans/:travelPlanId/rooms
 * Allocates rooms and assigns travelers. Validates room capacity & prevents duplicate assignment.
 */
export const AllocateRooms = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;
    const { hotelAssignmentId, rooms } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!hotelAssignmentId) {
      return sendError(res, 400, "hotelAssignmentId is required.", requestId);
    }

    if (!Array.isArray(rooms) || rooms.length === 0) {
      return sendError(res, 400, "rooms array is required.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    const hotel = await TravelHotelAssignmentModel.findOne({ _id: hotelAssignmentId, travelPlanId, ...scope });
    if (!hotel) {
      return sendError(res, 404, "Hotel assignment not found.", requestId);
    }

    if (["completed", "cancelled"].includes(hotel.status)) {
      return sendError(res, 400, `Cannot allocate rooms for a hotel stay in '${hotel.status}' status.`, requestId);
    }

    // Business Rule: "Traveler Not Assigned Twice." Reject a single request
    // that tries to put the same traveler in two different rooms at once.
    const travelerIdsInThisRequest = new Map();
    for (const roomObj of rooms) {
      for (const tId of roomObj.travelerIds || []) {
        const key = tId.toString();
        if (travelerIdsInThisRequest.has(key) && travelerIdsInThisRequest.get(key) !== roomObj.roomNumber) {
          return sendError(res, 400, `Traveler '${tId}' cannot be assigned to more than one room in the same request.`, requestId);
        }
        travelerIdsInThisRequest.set(key, roomObj.roomNumber);
      }
    }

    // "Supports room change": if a traveler is currently in a different
    // room on this hotel assignment, relocating them here removes them
    // from their old room (and updates its occupancy) instead of leaving a
    // stale duplicate assignment — this is what satisfies both "Traveler
    // Not Assigned Twice" and "Supports room change" together.
    const relocatedFrom = [];

    const allocatedRooms = [];

    for (const roomObj of rooms) {
      const { roomNumber, travelerIds = [] } = roomObj;

      if (!roomNumber) {
        return sendError(res, 400, "roomNumber is required for each room allocation.", requestId);
      }

      // "Senior Enterprise Improvement: dedicated Room Inventory" / AI
      // Coding Rule "Occupancy Validation." Was previously a free-text
      // roomNumber with a hardcoded capacity guess and zero connection to
      // the real, already-existing HotelRoomInventoryModel (a genuinely
      // unused model). Resolved against real inventory when the hotel is
      // catalogued; falls back to config-driven ad-hoc capacity otherwise
      // (uncatalogued/package hotels).
      let roomType = roomObj.roomType || "Quad";
      let maxCapacity = roomObj.capacity || null;
      let roomInventoryId = null;
      let inventoryRoom = null;

      if (hotel.hotelCatalogId) {
        inventoryRoom = await HotelRoomInventoryModel.findOne({ tenantId, hotelCatalogId: hotel.hotelCatalogId, roomNumber });
        if (inventoryRoom) {
          if (inventoryRoom.status === "maintenance") {
            return sendError(res, 422, `Room ${roomNumber} is under maintenance and cannot be allocated.`, requestId);
          }
          roomInventoryId = inventoryRoom._id;
          roomType = inventoryRoom.roomType;
          maxCapacity = inventoryRoom.capacity;
        }
      }

      if (!maxCapacity) {
        maxCapacity = hotelConfig.roomTypeCapacities[roomType] || 4;
      }

      // Business Rule: "Room occupancy cannot exceed capacity."
      if (travelerIds.length > maxCapacity) {
        return sendError(res, 400, `Room ${roomNumber} (${roomType}) capacity is ${maxCapacity}, but ${travelerIds.length} travelers were provided. Occupancy validation failed.`, requestId);
      }

      const roomTravelers = [];
      const roomGenders = new Set();
      for (const tId of travelerIds) {
        // Validation Rule: "Traveler Exists"
        const travelerSnapshot = travelPlan.travelerSnapshots.find((s) => s.travelerId.toString() === tId.toString() || s._id.toString() === tId.toString());
        if (!travelerSnapshot) {
          return sendError(res, 400, `Traveler ID '${tId}' does not belong to this Travel Plan.`, requestId);
        }
        roomTravelers.push({
          travelerId: travelerSnapshot.travelerId || travelerSnapshot._id,
          travelerName: travelerSnapshot.fullName || `${travelerSnapshot.firstName} ${travelerSnapshot.lastName}`
        });
        if (travelerSnapshot.gender) roomGenders.add(travelerSnapshot.gender);

        // Room change: strip this traveler out of whichever OTHER room on
        // this hotel assignment currently holds them.
        hotel.rooms.forEach((existingRoom) => {
          if (existingRoom.roomNumber === roomNumber) return;
          const idx = existingRoom.travelerIds.findIndex((id) => id.toString() === tId.toString());
          if (idx >= 0) {
            existingRoom.travelerIds.splice(idx, 1);
            existingRoom.travelers = existingRoom.travelers.filter((t) => t.travelerId.toString() !== tId.toString());
            existingRoom.occupancy = existingRoom.travelerIds.length;
            relocatedFrom.push({ travelerId: tId, fromRoom: existingRoom.roomNumber, toRoom: roomNumber });
          }
        });
      }

      const newRoom = {
        roomInventoryId,
        roomType,
        roomNumber,
        capacity: maxCapacity,
        occupancy: roomTravelers.length,
        travelerIds: roomTravelers.map((t) => t.travelerId),
        travelers: roomTravelers,
        hasMixedGenderOccupancy: roomGenders.size > 1
      };

      // Replace or add room
      const existingRoomIndex = hotel.rooms.findIndex((r) => r.roomNumber === roomNumber);
      if (existingRoomIndex >= 0) {
        hotel.rooms[existingRoomIndex] = newRoom;
      } else {
        hotel.rooms.push(newRoom);
      }

      if (inventoryRoom && roomTravelers.length > 0 && inventoryRoom.status !== "occupied") {
        inventoryRoom.status = "occupied";
        await inventoryRoom.save();
      }

      allocatedRooms.push(newRoom);
    }

    await hotel.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "RoomAssigned",
      title: "Rooms Allocated",
      description: `Allocated ${allocatedRooms.length} room(s) at ${hotel.hotelName}`,
      performedBy: userId,
      metadata: { relocatedFrom }
    });

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TravelerRoomAssigned",
      title: "Travelers Assigned to Rooms",
      description: `Assigned travelers to room allocations at ${hotel.hotelName}`,
      performedBy: userId
    });

    publishEvent("RoomAssigned", {
      travelPlanId,
      hotelAssignmentId,
      roomCount: allocatedRooms.length,
      tenantId
    });
    // Domain Events (Part 4): TravelerRoomAssigned — was previously only a
    // timeline log entry, never on the actual event bus.
    publishEvent("TravelerRoomAssigned", {
      travelPlanId,
      hotelAssignmentId,
      tenantId,
      travelerCount: allocatedRooms.reduce((sum, r) => sum + r.travelerIds.length, 0)
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ALLOCATE_HOTEL_ROOMS",
        module: "HotelOperations",
        targetId: hotelAssignmentId,
        details: { roomCount: allocatedRooms.length, relocatedFrom }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Rooms allocated successfully.", { rooms: hotel.rooms, relocatedFrom }, requestId);
  } catch (err) {
    console.error("AllocateRooms Error:", err);
    return sendError(res, 500, err.message || "Failed to allocate rooms.", requestId);
  }
};

/**
 * 5. PATCH /api/v1/travel-plans/:travelPlanId/hotels/:hotelAssignmentId/status
 * Updates live hotel execution status & actual check-in/out timestamps.
 */
export const UpdateHotelExecutionStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, hotelAssignmentId } = req.params;
    const { status, actualCheckIn, actualCheckOut, action, comments } = req.body;

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

    const hotel = await TravelHotelAssignmentModel.findOne({ _id: hotelAssignmentId, travelPlanId, ...scope });
    if (!hotel) {
      return sendError(res, 404, "Hotel assignment not found.", requestId);
    }

    // "Validate Transition" — was previously a flat membership check with
    // zero transition-validity checking (same "workflow bypass" bug class
    // fixed for Booking/Travel Plan/Flight). Now routed through the real,
    // state-aware Hotel workflow (utils/hotelConfig.js).
    const normalizedStatus = status ? status.toLowerCase() : null;
    let transitionResult;
    try {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "Hotel",
        entityId: hotel._id,
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
    hotel.status = transitionResult.currentState;

    if (actualCheckIn) {
      hotel.actualCheckIn = new Date(actualCheckIn);
      changes.actualCheckIn = hotel.actualCheckIn;
    }

    if (actualCheckOut) {
      hotel.actualCheckOut = new Date(actualCheckOut);
      changes.actualCheckOut = hotel.actualCheckOut;
    }

    // Version-history tracking — previously absent on this endpoint (unlike
    // UpdateTravelPlanHotel), so actual check-in/out corrections went
    // untracked.
    hotel.version = (hotel.version || 1) + 1;
    hotel.versionHistory.push({
      version: hotel.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await hotel.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "HotelStatusUpdated",
      title: `Hotel Status: ${transitionResult.currentState.toUpperCase()}`,
      description: `Hotel ${hotel.hotelName} status updated to '${transitionResult.currentState}' via '${transitionResult.actionPerformed}'`,
      performedBy: userId,
      metadata: { status: transitionResult.currentState, actualCheckIn, actualCheckOut }
    });

    publishEvent("HotelStatusUpdated", {
      travelPlanId,
      hotelAssignmentId,
      status: transitionResult.currentState,
      tenantId
    });

    return sendSuccess(res, 200, "Hotel execution status updated successfully.", hotel, requestId);
  } catch (err) {
    console.error("UpdateHotelExecutionStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to update hotel status.", requestId);
  }
};

/**
 * 6. POST /api/v1/travel-plans/:travelPlanId/hotels/:hotelAssignmentId/incidents
 * Reports hotel incidents (e.g. Room not ready, lost key, medical emergency, overbooking).
 */
export const ReportHotelIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, hotelAssignmentId } = req.params;
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
    if (severity && !hotelConfig.incidentSeverities.includes(severity)) {
      return sendError(res, 400, `Invalid severity '${severity}'. Must be one of: ${hotelConfig.incidentSeverities.join(", ")}.`, requestId);
    }

    const hotel = await TravelHotelAssignmentModel.findOne({ _id: hotelAssignmentId, travelPlanId, ...scope });
    if (!hotel) {
      return sendError(res, 404, "Hotel assignment not found.", requestId);
    }

    const incident = {
      incidentType,
      severity: severity || "Medium",
      description,
      reportedAt: new Date(),
      reportedBy: req.auth?.name || userId || "Staff",
      resolution: resolution || null
    };

    hotel.incidents.push(incident);
    await hotel.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "HotelIncidentReported",
      title: `Hotel Incident: ${incidentType}`,
      description: `[Severity: ${incident.severity}] ${description}`,
      performedBy: userId,
      metadata: incident
    });

    publishEvent("HotelIncidentReported", {
      travelPlanId,
      hotelAssignmentId,
      incidentType,
      severity: incident.severity,
      tenantId
    });

    return sendSuccess(res, 201, "Hotel incident reported successfully.", incident, requestId);
  } catch (err) {
    console.error("ReportHotelIncident Error:", err);
    return sendError(res, 500, err.message || "Failed to report hotel incident.", requestId);
  }
};
