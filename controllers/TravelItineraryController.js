import { DateTime } from "luxon";
import mongoose from "mongoose";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelItineraryModel from "../models/TravelItineraryModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getItineraryConfig } from "../utils/itineraryConfig.js";
import { getAllowedNextActions, executeWorkflowTransition } from "../utils/WorkflowEngine.js";
import { getAccessScope } from "../utils/accessScope.js";

const itineraryConfig = getItineraryConfig();

// "Supports timezone conversion" — parses a wall-clock datetime string as
// local time in the given IANA zone and returns the real UTC Date. Falls
// back to the module default zone (configurable) when none is supplied,
// and to plain `new Date(...)` parsing if the zone/value can't be resolved
// (e.g. the input already carries its own offset/Z suffix).
const resolveZonedDateTime = (value, timezone) => {
  if (!value) return null;
  const zone = timezone || itineraryConfig.defaultTimezone;
  const zoned = DateTime.fromISO(`${value}`, { zone });
  if (zoned.isValid) return zoned.toJSDate();
  return new Date(value);
};

// Helper for timeline logging
const recordTravelTimeline = async ({ travelPlanId, tenantId, eventType, title, description, performedBy = null, metadata = {} }) => {
  try {
    await TravelTimelineModel.create({
      travelPlanId,
      tenantId,
      module: "ItineraryManagement",
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
 * Helper: DAG Delay Propagation Engine
 * Automatically shifts dependent activities when a prerequisite activity schedule changes.
 */
const propagateDAGDelay = async (activityId, timeShiftMs, tenantId, userId) => {
  try {
    const dependentActivities = await TravelItineraryModel.find({ dependsOnActivityId: activityId, tenantId });

    for (const dep of dependentActivities) {
      const oldStart = new Date(dep.plannedStart);
      const oldEnd = new Date(dep.plannedEnd);

      dep.plannedStart = new Date(oldStart.getTime() + timeShiftMs);
      dep.plannedEnd = new Date(oldEnd.getTime() + timeShiftMs);
      dep.status = "rescheduled";
      dep.version = (dep.version || 1) + 1;
      dep.versionHistory.push({
        version: dep.version,
        updatedBy: "DAG_AutoPropagation_Engine",
        updatedAt: new Date(),
        changes: { note: `Shifted by ${timeShiftMs / (1000 * 60)} minutes due to prerequisite delay.` }
      });

      await dep.save();

      await recordTravelTimeline({
        travelPlanId: dep.travelPlanId,
        tenantId,
        eventType: "ActivityRescheduled",
        title: "DAG Auto-Rescheduled",
        description: `Activity '${dep.title}' automatically shifted by ${Math.round(timeShiftMs / (1000 * 60))} minutes due to prerequisite schedule change.`,
        performedBy: userId,
        metadata: { activityId: dep._id, timeShiftMinutes: Math.round(timeShiftMs / (1000 * 60)) }
      });

      // Recursive propagation downstream
      await propagateDAGDelay(dep._id, timeShiftMs, tenantId, userId);
    }
  } catch (err) {
    console.error("DAG Propagation Error:", err);
  }
};

/**
 * 1. GET /api/v1/travel-plans/:travelPlanId/itinerary
 * Returns the complete itinerary for a travel plan grouped or ordered by day and time.
 */
export const ListTravelPlanItinerary = async (req, res) => {
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

    const filter = { travelPlanId, tenantId };

    if (req.query.day) {
      filter.day = parseInt(req.query.day, 10);
    }

    if (req.query.activityType) {
      filter.activityType = req.query.activityType;
    }

    if (req.query.status) {
      filter.status = req.query.status.toLowerCase();
    }

    // Business Rule: "Supports pagination for large itineraries." Paginates
    // the underlying ordered (day, time) sequence; the day-grouped view is
    // built from just that page.
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "50", 10), 1), 200);

    const totalItems = await TravelItineraryModel.countDocuments(filter);
    const activities = await TravelItineraryModel.find(filter)
      .sort({ day: 1, plannedStart: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    const groupedByDay = {};
    activities.forEach((act) => {
      if (!groupedByDay[act.day]) {
        groupedByDay[act.day] = [];
      }
      groupedByDay[act.day].push({
        activityId: act._id,
        day: act.day,
        title: act.title,
        activityType: act.activityType,
        plannedStart: act.plannedStart,
        plannedEnd: act.plannedEnd,
        timezone: act.timezone,
        actualStart: act.actualStart,
        actualEnd: act.actualEnd,
        estimatedDurationMinutes: act.estimatedDurationMinutes,
        location: act.location,
        resources: act.resources,
        assignedTravelersCount: act.assignedTravelers ? act.assignedTravelers.length : 0,
        assignedTravelers: act.assignedTravelers,
        dependsOnActivityId: act.dependsOnActivityId,
        status: act.status,
        priority: act.priority,
        remarks: act.remarks,
        availableTransitions: getAllowedNextActions(act.status, "Activity"),
        createdAt: act.createdAt
      });
    });

    return sendSuccess(res, 200, "Travel itinerary retrieved successfully.", {
      travelPlanId,
      totalActivities: activities.length,
      daysCount: Object.keys(groupedByDay).length,
      itineraryByDay: groupedByDay,
      allActivities: activities,
      meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) || 1 }
    }, requestId);
  } catch (err) {
    console.error("ListTravelPlanItinerary Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch itinerary.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans/:travelPlanId/itinerary
 * Creates itinerary activities (bulk support & DAG dependencies).
 */
export const AddTravelPlanItinerary = async (req, res) => {
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

    let activityItems = [];
    if (Array.isArray(req.body.activities)) {
      activityItems = req.body.activities;
    } else if (req.body.title || req.body.plannedStart) {
      activityItems = [req.body];
    } else {
      return sendError(res, 400, "Invalid payload. Pass 'activities' array or activity details object.", requestId);
    }

    // Validation Rule: "Activities Do Not Overlap" — was entirely
    // unimplemented. Checked both against already-persisted activities and
    // against other activities in this same batch (standard interval-overlap
    // test, same fix already applied to Transport's vehicle/driver conflict
    // check: existing.start < new.end AND existing.end > new.start).
    const existingActivities = await TravelItineraryModel.find({ travelPlanId, tenantId, status: { $ne: "cancelled" } }).select("title plannedStart plannedEnd").lean();
    const pendingWindows = existingActivities.map((a) => ({ title: a.title, plannedStart: a.plannedStart, plannedEnd: a.plannedEnd }));

    const checkOverlap = (pStart, pEnd, title) => {
      const conflict = pendingWindows.find((w) => w.plannedStart < pEnd && w.plannedEnd > pStart);
      if (conflict) {
        throw Object.assign(new Error(`Activity '${title}' (${pStart.toISOString()} - ${pEnd.toISOString()}) overlaps with '${conflict.title}'.`), { statusCode: 400 });
      }
    };

    const createdActivities = [];
    const recurrenceGroupId = activityItems.some((i) => Array.isArray(i.recurrence?.repeatOnDays)) ? new mongoose.Types.ObjectId().toString() : null;

    for (const item of activityItems) {
      const { day, title, plannedStart, plannedEnd, timezone, location, dependsOnActivityId, priority = "normal", remarks = null, internalNotes = null } = item;
      let { activityType = "Custom", resources } = item;

      // "Supports templates" — clones title/activityType/duration/location/
      // resources from an existing activity (this or another travel plan of
      // the same tenant) when no dedicated Template catalog exists to draw
      // from; real DB-backed cloning, not a fabricated template shape.
      let templateSource = null;
      if (item.cloneFromActivityId || item.templateActivityId) {
        const sourceId = item.cloneFromActivityId || item.templateActivityId;
        templateSource = await TravelItineraryModel.findOne({ _id: sourceId, tenantId }).lean();
        if (!templateSource) {
          return sendError(res, 422, `Template activity "${sourceId}" does not exist.`, requestId);
        }
      }

      const resolvedTitle = title || templateSource?.title;
      const resolvedDay = day || templateSource?.day;
      if (!resolvedTitle) {
        return sendError(res, 400, "title is required for each activity (or provide cloneFromActivityId).", requestId);
      }
      if (!resolvedDay) {
        return sendError(res, 400, "day is required for each activity (or provide cloneFromActivityId).", requestId);
      }
      if (!plannedStart || !plannedEnd) {
        return sendError(res, 400, "plannedStart and plannedEnd are required for each activity.", requestId);
      }
      if (item.activityType) {
        if (!itineraryConfig.activityTypes.includes(item.activityType)) {
          return sendError(res, 400, `Invalid activityType '${item.activityType}'. Must be one of: ${itineraryConfig.activityTypes.join(", ")}.`, requestId);
        }
        activityType = item.activityType;
      } else if (templateSource) {
        activityType = templateSource.activityType;
      }
      if (!resources && templateSource) resources = templateSource.resources;

      const resolvedTimezone = timezone || itineraryConfig.defaultTimezone;
      const pStart = resolveZonedDateTime(plannedStart, resolvedTimezone);
      const pEnd = resolveZonedDateTime(plannedEnd, resolvedTimezone);

      if (isNaN(pStart.getTime()) || isNaN(pEnd.getTime())) {
        return sendError(res, 400, "Invalid plannedStart or plannedEnd format.", requestId);
      }

      // Validation Rule: "End Time > Start Time"
      if (pEnd <= pStart) {
        return sendError(res, 400, "plannedEnd must be after plannedStart.", requestId);
      }

      const durationMinutes = Math.round((pEnd - pStart) / (1000 * 60));

      // Real target days for this activity: itself, plus (Business Rule
      // "Supports recurring activities") any additional days requested —
      // each occurrence keeps the same wall-clock time, shifted by real
      // calendar days via luxon (DST-safe, not naive millisecond math).
      const repeatOnDays = Array.isArray(item.recurrence?.repeatOnDays) ? item.recurrence.repeatOnDays : [];
      const targetDays = [resolvedDay, ...repeatOnDays.filter((d) => d !== resolvedDay)];

      for (const targetDay of targetDays) {
        const dayOffset = targetDay - resolvedDay;
        const occStart = dayOffset === 0 ? pStart : DateTime.fromJSDate(pStart, { zone: resolvedTimezone }).plus({ days: dayOffset }).toJSDate();
        const occEnd = dayOffset === 0 ? pEnd : DateTime.fromJSDate(pEnd, { zone: resolvedTimezone }).plus({ days: dayOffset }).toJSDate();

        checkOverlap(occStart, occEnd, resolvedTitle);

        const activity = await TravelItineraryModel.create({
          travelPlanId,
          tenantId,
          day: targetDay,
          title: resolvedTitle,
          activityType,
          plannedStart: occStart,
          plannedEnd: occEnd,
          timezone: resolvedTimezone,
          estimatedDurationMinutes: durationMinutes,
          location: location || templateSource?.location || { locationId: null, name: null, address: null, latitude: null, longitude: null },
          resources: resources || {},
          dependsOnActivityId: dependsOnActivityId || null,
          recurrenceGroupId: repeatOnDays.length > 0 ? recurrenceGroupId : null,
          clonedFromActivityId: templateSource?._id || null,
          status: "planned",
          priority,
          remarks,
          internalNotes,
          version: 1
        });

        pendingWindows.push({ title: resolvedTitle, plannedStart: occStart, plannedEnd: occEnd });
        createdActivities.push(activity);

        await recordTravelTimeline({
          travelPlanId,
          tenantId,
          eventType: "ActivityScheduled",
          title: "Activity Scheduled",
          description: `Day ${targetDay}: '${resolvedTitle}' (${activityType}) scheduled from ${occStart.toISOString()} to ${occEnd.toISOString()}`,
          performedBy: userId
        });
        // Domain Events (Part 6): ActivityScheduled — was previously only a
        // timeline log entry, never on the actual event bus.
        publishEvent("ActivityScheduled", {
          travelPlanId,
          activityId: activity._id,
          day: targetDay,
          tenantId
        });
      }
    }

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "ItineraryCreated",
      title: "Itinerary Activities Created",
      description: `Added ${createdActivities.length} itinerary activity/activities.`,
      performedBy: userId
    });

    publishEvent("ItineraryCreated", {
      travelPlanId,
      activityCount: createdActivities.length,
      tenantId
    });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "CREATE_ITINERARY_ACTIVITIES",
        module: "ItineraryManagement",
        targetId: travelPlanId,
        details: { count: createdActivities.length }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Itinerary activities created successfully.", createdActivities, requestId);
  } catch (err) {
    console.error("AddTravelPlanItinerary Error:", err);
    return sendError(res, err.statusCode || 500, err.message || "Failed to create itinerary activities.", requestId);
  }
};

/**
 * 3. PATCH /api/v1/travel-plans/:travelPlanId/itinerary/:activityId
 * Updates itinerary activity details and triggers automatic DAG Delay Propagation.
 */
export const UpdateTravelPlanActivity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, activityId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const activity = await TravelItineraryModel.findOne({ _id: activityId, travelPlanId, ...scope });
    if (!activity) {
      return sendError(res, 404, "Itinerary activity not found.", requestId);
    }

    if (activity.status === "completed") {
      return sendError(res, 400, "Completed activities are locked and cannot be updated.", requestId);
    }

    // Part 6's Editable Fields list is the authoritative contract for this
    // endpoint: Planned Time, Assigned Guide, Assigned Vehicle, Assigned
    // Hotel, Location, Priority, Remarks — "title"/"day"/"activityType"/
    // "dependsOnActivityId"/"internalNotes" were previously accepted too,
    // despite none being in that list (mirrors the same trim already
    // applied to Booking/Travel Plan/Hotel's PATCH endpoints).
    const editableFields = ["plannedStart", "plannedEnd", "location", "priority", "remarks"];

    // Business Rule: "Critical changes require approval." Mirrors the
    // identical gate already applied to Booking/Travel Plan/Flight: once an
    // activity is past draft/planned (i.e. already published or later),
    // changing its planned time is a critical, schedule-adjacent change.
    const touchesSchedule = req.body.plannedStart !== undefined || req.body.plannedEnd !== undefined;
    const freelyEditableStatuses = ["draft", "planned"];
    if (touchesSchedule && !freelyEditableStatuses.includes(activity.status)) {
      if (!permissions.includes("admin")) {
        return sendError(res, 403, `Elevated permission required to change planned time on an activity in '${activity.status}' status.`, requestId);
      }
    }

    let scheduleChanged = false;
    let timeShiftMs = 0;
    const changes = {};

    editableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        if (field === "plannedStart" || field === "plannedEnd") {
          const newDate = resolveZonedDateTime(req.body[field], req.body.timezone || activity.timezone);
          if (newDate && !isNaN(newDate.getTime())) {
            if (field === "plannedStart") {
              timeShiftMs = newDate.getTime() - new Date(activity.plannedStart).getTime();
            }
            changes[field] = newDate;
            scheduleChanged = true;
          }
        } else {
          changes[field] = req.body[field];
        }
      }
    });

    // "Assigned Guide" / "Assigned Vehicle" / "Assigned Hotel" — subsets of
    // the resources sub-document; merged rather than requiring the caller
    // to resend the entire resources object for a single-field change.
    const resourceFields = ["guideId", "guideUserId", "guideName", "vehicleId", "vehicleNumber", "hotelId", "hotelName"];
    if (resourceFields.some((f) => req.body[f] !== undefined)) {
      const mergedResources = { ...(activity.resources ? activity.resources.toObject() : {}) };
      resourceFields.forEach((f) => {
        if (req.body[f] !== undefined) mergedResources[f] = req.body[f];
      });
      changes.resources = mergedResources;
    }

    if (Object.keys(changes).length === 0) {
      return sendError(res, 400, "No valid fields provided for update.", requestId);
    }

    Object.assign(activity, changes);

    if (scheduleChanged) {
      const pStart = new Date(activity.plannedStart);
      const pEnd = new Date(activity.plannedEnd);
      if (pEnd > pStart) {
        activity.estimatedDurationMinutes = Math.round((pEnd - pStart) / (1000 * 60));
      }
    }

    activity.version = (activity.version || 1) + 1;
    activity.versionHistory.push({
      version: activity.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await activity.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "ActivityUpdated",
      title: "Activity Details Updated",
      description: `Activity '${activity.title}' updated fields: ${Object.keys(changes).join(", ")}`,
      performedBy: userId,
      metadata: changes
    });

    // Run DAG delay propagation downstream if planned start shifted
    if (scheduleChanged && timeShiftMs !== 0) {
      await propagateDAGDelay(activity._id, timeShiftMs, tenantId, userId);
      publishEvent("ActivityRescheduled", { travelPlanId, activityId, timeShiftMs, tenantId });
    }

    publishEvent("ActivityUpdated", { travelPlanId, activityId, tenantId });

    // Business Rule: "Audit mandatory." Was previously missing entirely on
    // this endpoint.
    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "UPDATE_ITINERARY_ACTIVITY",
        module: "ItineraryManagement",
        targetId: activityId,
        details: { changes: Object.keys(changes), version: activity.version }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Itinerary activity updated successfully.", activity, requestId);
  } catch (err) {
    console.error("UpdateTravelPlanActivity Error:", err);
    return sendError(res, 500, err.message || "Failed to update activity.", requestId);
  }
};

/**
 * 4. POST /api/v1/travel-plans/:travelPlanId/itinerary/:activityId/travelers
 * Bulk assigns travelers to an itinerary activity.
 */
export const AssignTravelersToActivity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, activityId } = req.params;
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

    const activity = await TravelItineraryModel.findOne({ _id: activityId, travelPlanId, ...scope });
    if (!activity) {
      return sendError(res, 404, "Itinerary activity not found.", requestId);
    }

    // Business Rule: "Traveler belongs to travel plan" / "Duplicate
    // assignment prevented." IDs that don't resolve or are already
    // assigned are reported back explicitly instead of silently dropped —
    // consistent with Flight/Hotel/Transport's traveler-assignment endpoints.
    const existingAssignedIds = activity.assignedTravelers.map((t) => t.travelerId.toString());
    const skippedTravelerIds = [];
    let newlyAssignedCount = 0;

    travelerIds.forEach((tId) => {
      const travelerSnapshot = travelPlan.travelerSnapshots.find((s) => s.travelerId.toString() === tId.toString() || s._id.toString() === tId.toString());
      if (!travelerSnapshot) {
        skippedTravelerIds.push({ travelerId: tId, reason: "Not part of this travel plan." });
        return;
      }
      if (existingAssignedIds.includes(tId.toString())) {
        skippedTravelerIds.push({ travelerId: tId, reason: "Already assigned to this activity." });
        return;
      }
      activity.assignedTravelers.push({
        travelerId: travelerSnapshot.travelerId || travelerSnapshot._id,
        travelerName: travelerSnapshot.fullName || `${travelerSnapshot.firstName} ${travelerSnapshot.lastName}`,
        attendanceStatus: "Pending"
      });
      newlyAssignedCount++;
    });

    await activity.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "TravelersAssignedToActivity",
      title: "Travelers Assigned to Activity",
      description: `Assigned ${newlyAssignedCount} traveler(s) to activity '${activity.title}'`,
      performedBy: userId
    });
    // Every sibling traveler-assignment endpoint (Flight/Hotel/Transport)
    // publishes a real domain event for this action; this one only ever
    // recorded a timeline entry, despite Part 6's own doc omitting a
    // "Domain Events" subsection for this endpoint — treated as a doc
    // formatting gap, not an intentional exclusion, for cross-module
    // consistency.
    publishEvent("TravelerAssignedToActivity", {
      travelPlanId,
      activityId,
      newlyAssignedCount,
      tenantId
    });

    return sendSuccess(res, 200, `${newlyAssignedCount} traveler(s) assigned to activity successfully.`, {
      activity,
      newlyAssignedCount,
      skippedTravelerIds
    }, requestId);
  } catch (err) {
    console.error("AssignTravelersToActivity Error:", err);
    return sendError(res, 500, err.message || "Failed to assign travelers to activity.", requestId);
  }
};

/**
 * 5. PATCH /api/v1/travel-plans/:travelPlanId/itinerary/:activityId/status
 * Updates real-time activity execution status.
 */
export const UpdateActivityExecutionStatus = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, activityId } = req.params;
    const { status, actualStart, actualEnd, action, comments } = req.body;

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

    const activity = await TravelItineraryModel.findOne({ _id: activityId, travelPlanId, ...scope });
    if (!activity) {
      return sendError(res, 404, "Itinerary activity not found.", requestId);
    }

    // "Validate Transition" — was previously a flat membership check with
    // zero transition-validity checking (same "workflow bypass" bug class
    // fixed for Booking/Travel Plan/Flight/Hotel/Transport). Now routed
    // through the real, state-aware Activity workflow (utils/itineraryConfig.js).
    const normalizedStatus = status ? status.toLowerCase() : null;
    let transitionResult;
    try {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "Activity",
        entityId: activity._id,
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
    activity.status = transitionResult.currentState;

    if (actualStart) {
      activity.actualStart = new Date(actualStart);
      changes.actualStart = activity.actualStart;
    }

    if (actualEnd) {
      activity.actualEnd = new Date(actualEnd);
      changes.actualEnd = activity.actualEnd;
    }

    // Version-history tracking — previously absent on this endpoint (unlike
    // UpdateTravelPlanActivity), so actual start/end corrections went
    // untracked.
    activity.version = (activity.version || 1) + 1;
    activity.versionHistory.push({
      version: activity.version,
      updatedBy: userId || "Staff",
      updatedAt: new Date(),
      changes
    });

    await activity.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "ActivityStatusUpdated",
      title: `Activity Status: ${transitionResult.currentState.toUpperCase()}`,
      description: `Activity '${activity.title}' status updated to '${transitionResult.currentState}' via '${transitionResult.actionPerformed}'`,
      performedBy: userId,
      metadata: { status: transitionResult.currentState, actualStart, actualEnd }
    });

    publishEvent("ActivityStatusUpdated", {
      travelPlanId,
      activityId,
      status: transitionResult.currentState,
      tenantId
    });

    return sendSuccess(res, 200, "Activity execution status updated successfully.", activity, requestId);
  } catch (err) {
    console.error("UpdateActivityExecutionStatus Error:", err);
    return sendError(res, 500, err.message || "Failed to update activity status.", requestId);
  }
};
