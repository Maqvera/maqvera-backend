import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelItineraryModel from "../models/TravelItineraryModel.js";
import TravelAttendanceSessionModel from "../models/TravelAttendanceSessionModel.js";
import TravelAttendanceModel from "../models/TravelAttendanceModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAttendanceConfig } from "../utils/attendanceConfig.js";
import { executeWorkflowTransition } from "../utils/WorkflowEngine.js";
import { getAccessScope } from "../utils/accessScope.js";

const attendanceConfig = getAttendanceConfig();

// Helper for timeline logging
const recordTravelTimeline = async ({ travelPlanId, tenantId, eventType, title, description, performedBy = null, metadata = {} }) => {
  try {
    await TravelTimelineModel.create({
      travelPlanId,
      tenantId,
      module: "AttendanceManagement",
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
 * 1. GET /api/v1/travel-plans/:travelPlanId/attendance
 * Returns attendance records for a travel plan.
 */
export const ListTravelPlanAttendance = async (req, res) => {
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

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "20", 10), 1), 100);

    const filter = { travelPlanId, tenantId };

    if (req.query.activityId) {
      filter.activityId = req.query.activityId;
    }

    // Query Parameter "day" — attendance records don't store the day
    // number directly; resolved via the activities that fall on that day.
    if (req.query.day) {
      const dayActivities = await TravelItineraryModel.find({ travelPlanId, tenantId, day: parseInt(req.query.day, 10) }).select("_id").lean();
      filter.activityId = { $in: dayActivities.map((a) => a._id) };
    }

    if (req.query.travelerId) {
      filter.travelerId = req.query.travelerId;
    }

    if (req.query.status) {
      filter.status = req.query.status;
    }

    const totalItems = await TravelAttendanceModel.countDocuments(filter);
    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    // Business Rule: "Ordered by activity time" — was previously sorted by
    // `createdAt` (when the attendance stub row happened to be inserted),
    // not the underlying activity's real scheduled time. Joined against
    // the activity to sort correctly and to surface "Activity Name"
    // (explicitly listed in Response Includes but previously absent).
    const attendanceRecords = await TravelAttendanceModel.aggregate([
      { $match: filter },
      { $lookup: { from: "travel_itineraries", localField: "activityId", foreignField: "_id", as: "activity" } },
      { $unwind: { path: "$activity", preserveNullAndEmptyArrays: true } },
      { $sort: { "activity.plannedStart": 1, createdAt: 1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize }
    ]);

    const formattedData = attendanceRecords.map((a) => ({
      attendanceId: a._id,
      attendanceSessionId: a.attendanceSessionId,
      travelPlanId: a.travelPlanId,
      activityId: a.activityId,
      activityName: a.activity?.title || null,
      travelerId: a.travelerId,
      travelerName: a.travelerName,
      status: a.status,
      checkInTime: a.checkInTime,
      checkOutTime: a.checkOutTime,
      verificationMethod: a.verificationMethod,
      location: a.location,
      recordedBy: a.recordedBy,
      absenceReason: a.absenceReason,
      remarks: a.remarks,
      createdAt: a.createdAt
    }));

    return sendSuccess(res, 200, "Attendance records retrieved successfully.", {
      data: formattedData,
      meta: { page, pageSize, totalItems, totalPages }
    }, requestId);
  } catch (err) {
    console.error("ListTravelPlanAttendance Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch attendance records.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans/:travelPlanId/attendance
 * Creates an attendance session for an itinerary activity.
 */
export const CreateAttendanceSession = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;
    const { activityId, attendanceWindowStart, attendanceWindowEnd } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!activityId) {
      return sendError(res, 400, "activityId is required.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    const activity = await TravelItineraryModel.findOne({ _id: activityId, travelPlanId, tenantId });
    if (!activity) {
      return sendError(res, 404, "Itinerary activity not found.", requestId);
    }

    // Business Rule: "Supports recurring activities." When the target
    // activity is part of a recurrence group (Part 6's
    // recurrenceGroupId), optionally cascade session creation to every
    // sibling occurrence, not just the one activityId given.
    let targetActivities = [activity];
    if (req.body.applyToRecurrenceGroup && activity.recurrenceGroupId) {
      targetActivities = await TravelItineraryModel.find({ travelPlanId, tenantId, recurrenceGroupId: activity.recurrenceGroupId });
    }

    // "Attendance window configurable" — real config defaults, optionally
    // overridden per-request, instead of hardcoded literals.
    const policy = {
      checkInWindowMinutes: req.body.policy?.checkInWindowMinutes ?? attendanceConfig.defaultPolicy.checkInWindowMinutes,
      lateThresholdMinutes: req.body.policy?.lateThresholdMinutes ?? attendanceConfig.defaultPolicy.lateThresholdMinutes,
      missingThresholdMinutes: req.body.policy?.missingThresholdMinutes ?? attendanceConfig.defaultPolicy.missingThresholdMinutes
    };

    const createdSessions = [];
    const skippedActivities = [];

    for (const targetActivity of targetActivities) {
      // Validation Rule: "Attendance Session Not Duplicate" / Business
      // Rule: "Only one active attendance session per activity."
      const existingSession = await TravelAttendanceSessionModel.findOne({
        travelPlanId,
        activityId: targetActivity._id,
        tenantId,
        status: { $in: ["scheduled", "open"] }
      });

      if (existingSession) {
        if (targetActivities.length === 1) {
          return sendError(res, 400, `An active attendance session (${existingSession._id}) already exists for this activity.`, requestId);
        }
        skippedActivities.push({ activityId: targetActivity._id, reason: "Active session already exists." });
        continue;
      }

      const windowStart = (targetActivity._id.equals(activity._id) && attendanceWindowStart) ? new Date(attendanceWindowStart) : new Date(targetActivity.plannedStart);
      const windowEnd = (targetActivity._id.equals(activity._id) && attendanceWindowEnd) ? new Date(attendanceWindowEnd) : new Date(targetActivity.plannedEnd);

      const session = await TravelAttendanceSessionModel.create({
        travelPlanId,
        tenantId,
        branchId: travelPlan.branchId,
        activityId: targetActivity._id,
        activityName: targetActivity.title,
        attendanceWindowStart: windowStart,
        attendanceWindowEnd: windowEnd,
        status: "open",
        policy
      });

      // "Expected Travelers" — was previously stubbed for every traveler on
      // the whole travel plan regardless of whether they were actually
      // assigned to THIS activity (Part 6's AssignTravelersToActivity).
      // Falls back to the full roster only when no explicit sub-selection
      // was ever made for the activity.
      const expectedTravelers = (targetActivity.assignedTravelers && targetActivity.assignedTravelers.length > 0)
        ? targetActivity.assignedTravelers.map((t) => ({ travelerId: t.travelerId, travelerName: t.travelerName }))
        : (travelPlan.travelerSnapshots || []).map((t) => ({ travelerId: t.travelerId || t._id, travelerName: t.fullName || `${t.firstName} ${t.lastName}` }));

      if (expectedTravelers.length > 0) {
        const attendanceStubs = expectedTravelers.map((t) => ({
          attendanceSessionId: session._id,
          travelPlanId,
          tenantId,
          branchId: travelPlan.branchId,
          activityId: targetActivity._id,
          travelerId: t.travelerId,
          travelerName: t.travelerName,
          status: attendanceConfig.defaultAttendanceStatus,
          checkInTime: null,
          verificationMethod: "Manual",
          recordedBy: "System"
        }));

        await TravelAttendanceModel.insertMany(attendanceStubs);
      }

      await recordTravelTimeline({
        travelPlanId,
        tenantId,
        eventType: "AttendanceSessionCreated",
        title: "Attendance Session Opened",
        description: `Attendance session opened for activity '${targetActivity.title}'`,
        performedBy: userId
      });

      publishEvent("AttendanceSessionCreated", { travelPlanId, sessionId: session._id, activityId: targetActivity._id, tenantId });
      publishEvent("AttendanceWindowOpened", { travelPlanId, sessionId: session._id, windowStart, windowEnd, tenantId });

      // Business Workflow: "Notify Guide" — real event referencing the
      // activity's actually-assigned guide (Part 6's resources.guideId),
      // not a fabricated notification target.
      if (targetActivity.resources?.guideId) {
        publishEvent("NotificationRequested", {
          travelPlanId,
          tenantId,
          event: "AttendanceSessionCreated",
          recipientId: targetActivity.resources.guideId,
          recipientName: targetActivity.resources.guideName,
          activityId: targetActivity._id
        });
      }

      try {
        await AuditLogModel.create({
          tenantId,
          userId,
          action: "CREATE_ATTENDANCE_SESSION",
          module: "AttendanceManagement",
          targetId: session._id.toString(),
          details: { activityId: targetActivity._id, activityName: targetActivity.title }
        });
      } catch (auditErr) {
        console.error("Audit log error:", auditErr);
      }

      createdSessions.push(session);
    }

    return sendSuccess(res, 201, "Attendance session(s) created successfully.", {
      sessions: createdSessions,
      skippedActivities
    }, requestId);
  } catch (err) {
    console.error("CreateAttendanceSession Error:", err);
    return sendError(res, 500, err.message || "Failed to create attendance session.", requestId);
  }
};

/**
 * 3. PATCH /api/v1/travel-plans/:travelPlanId/attendance/:attendanceId
 * Records traveler attendance and evaluates Presence Policy Engine rules.
 */
export const RecordTravelerAttendance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId, attendanceId } = req.params;
    const { travelerId, status, verificationMethod = "Manual", remarks, location, absenceReason } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    // The doc's URL is /attendance/{attendanceId} with the traveler
    // specified separately in the body — {attendanceId} is the SESSION id
    // (one session has many travelers, each with their own record), not an
    // individual attendance record's own _id. The previous lookup treated
    // it as a record _id first and only fell back to an unscoped
    // {travelPlanId, travelerId} match — which, once a traveler has more
    // than one attendance record across the trip (any second activity),
    // could silently update the WRONG record via `findOne` picking an
    // arbitrary match. Session+traveler is now the primary, precise path.
    let record = null;
    if (travelerId) {
      record = await TravelAttendanceModel.findOne({ attendanceSessionId: attendanceId, travelerId, ...scope });
    }
    if (!record) {
      record = await TravelAttendanceModel.findOne({ _id: attendanceId, travelPlanId, ...scope });
    }

    if (!record) {
      return sendError(res, 404, "Attendance record not found.", requestId);
    }

    // Validation Rule: "Validate Verification"
    if (verificationMethod && !attendanceConfig.verificationMethods.includes(verificationMethod)) {
      return sendError(res, 400, `Invalid verificationMethod '${verificationMethod}'. Must be one of: ${attendanceConfig.verificationMethods.join(", ")}.`, requestId);
    }

    const session = record.attendanceSessionId ? await TravelAttendanceSessionModel.findById(record.attendanceSessionId) : null;

    // Validation Rule: "Validate Attendance Session"
    if (session && ["closed", "completed"].includes(session.status)) {
      return sendError(res, 400, `Cannot record attendance — session is already '${session.status}'.`, requestId);
    }

    let evaluatedStatus = status || "Checked In";
    const now = new Date();

    // Attendance Policy Engine Evaluation — "Late threshold configurable"
    // (now sourced from the session's real policy, itself config-driven).
    if (session && (evaluatedStatus === "Checked In" || evaluatedStatus === "Present")) {
      const windowStart = new Date(session.attendanceWindowStart);
      const lateThresholdMs = (session.policy?.lateThresholdMinutes ?? attendanceConfig.defaultPolicy.lateThresholdMinutes) * 60 * 1000;

      if (now.getTime() > windowStart.getTime() + lateThresholdMs) {
        evaluatedStatus = "Late";
      }
    }

    // "Validate Transition" — was previously a raw field assignment with no
    // transition-validity checking at all (same "workflow bypass" bug class
    // fixed for every other Travel module this session). Routed through the
    // real, state-aware Attendance workflow (utils/attendanceConfig.js).
    const targetState = evaluatedStatus.toLowerCase().replace(/\s+/g, "_");
    let transitionResult;
    try {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "Attendance",
        entityId: record._id,
        targetState,
        performedBy: userId,
        performedByName: req.auth?.name || "Staff",
        userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : []),
        comments: remarks || null
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

    // Reconstruct the doc-facing status label (e.g. "checked_in" -> "Checked In")
    // from the workflow's resolved state, keeping the stored value in the
    // same Title-Case vocabulary the rest of this module and its Mongoose
    // enum already use.
    evaluatedStatus = attendanceConfig.attendanceStatuses.find((s) => s.toLowerCase().replace(/\s+/g, "_") === transitionResult.currentState) || evaluatedStatus;

    record.status = evaluatedStatus;
    record.checkInTime = now;
    record.verificationMethod = verificationMethod;
    record.recordedBy = req.auth?.name || userId || "Staff";
    if (remarks) record.remarks = remarks;
    if (absenceReason) record.absenceReason = absenceReason;
    if (location) record.location = location;

    await record.save();

    await recordTravelTimeline({
      travelPlanId,
      tenantId,
      eventType: "AttendanceRecorded",
      title: `Attendance: ${record.travelerName}`,
      description: `Traveler ${record.travelerName} marked '${evaluatedStatus}' via ${verificationMethod}`,
      performedBy: userId,
      metadata: { travelerId: record.travelerId, status: evaluatedStatus, verificationMethod }
    });

    publishEvent("AttendanceRecorded", { travelPlanId, attendanceId: record._id, status: evaluatedStatus, tenantId });

    if (evaluatedStatus === "Late") {
      publishEvent("TravelerMarkedLate", { travelPlanId, travelerId: record.travelerId, tenantId });
    } else if (evaluatedStatus === "Missing") {
      publishEvent("TravelerMarkedMissing", { travelPlanId, travelerId: record.travelerId, tenantId });
      await recordTravelTimeline({
        travelPlanId,
        tenantId,
        eventType: "TravelerMarkedMissing",
        title: "ALERT: Traveler Missing",
        description: `High Priority Alert: ${record.travelerName} is marked MISSING!`,
        performedBy: userId
      });
    } else if (evaluatedStatus === "Emergency") {
      publishEvent("EmergencyReported", { travelPlanId, travelerId: record.travelerId, tenantId });
      // Business Rule: "Emergency status immediately notifies Operations."
      publishEvent("NotificationRequested", {
        travelPlanId,
        tenantId,
        event: "EmergencyReported",
        priority: "immediate",
        travelerId: record.travelerId,
        travelerName: record.travelerName
      });
      await recordTravelTimeline({
        travelPlanId,
        tenantId,
        eventType: "EmergencyReported",
        title: "CRITICAL: Emergency Reported",
        description: `Emergency reported for traveler ${record.travelerName}`,
        performedBy: userId
      });
    }

    // Audit Rule: every other write endpoint in this module logs to
    // AuditLogModel — this one can mark a traveler Missing/Emergency (the
    // highest-stakes status this endpoint can set) yet had no audit trail.
    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "RECORD_TRAVELER_ATTENDANCE",
        module: "AttendanceManagement",
        targetId: record._id.toString(),
        details: { travelPlanId, travelerId: record.travelerId, status: evaluatedStatus, verificationMethod }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Attendance recorded successfully.", record, requestId);
  } catch (err) {
    console.error("RecordTravelerAttendance Error:", err);
    return sendError(res, 500, err.message || "Failed to record attendance.", requestId);
  }
};

/**
 * 4. GET /api/v1/travel-plans/:travelPlanId/attendance/dashboard
 * Returns attendance analytics dashboard metrics.
 */
export const GetAttendanceDashboard = async (req, res) => {
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

    const records = await TravelAttendanceModel.find({ travelPlanId, tenantId });

    const totalTravelers = travelPlan.travelerSnapshots ? travelPlan.travelerSnapshots.length : 0;
    const present = records.filter((r) => r.status === "Present" || r.status === "Checked In").length;
    const checkedOut = records.filter((r) => r.status === "Checked Out").length;
    const late = records.filter((r) => r.status === "Late").length;
    const absent = records.filter((r) => r.status === "Absent").length;
    const excused = records.filter((r) => r.status === "Excused").length;
    const missing = records.filter((r) => r.status === "Missing").length;
    const emergency = records.filter((r) => r.status === "Emergency").length;

    const completionPercentage = totalTravelers > 0 ? Math.round(((present + checkedOut + late) / totalTravelers) * 100) : 0;
    const pendingCheckins = Math.max(totalTravelers - (present + checkedOut + late), 0);

    const dashboard = {
      travelPlanId,
      expectedTravelers: totalTravelers,
      present,
      checkedOut,
      late,
      absent,
      excused,
      missing,
      emergency,
      completionPercentage,
      pendingCheckIns: pendingCheckins
    };

    return sendSuccess(res, 200, "Attendance dashboard retrieved successfully.", dashboard, requestId);
  } catch (err) {
    console.error("GetAttendanceDashboard Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch attendance dashboard.", requestId);
  }
};
