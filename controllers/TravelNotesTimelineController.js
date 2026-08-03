import { v4 as uuidv4 } from "uuid";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import TravelNoteModel from "../models/TravelNoteModel.js";
import UnifiedActivityStreamModel from "../models/UnifiedActivityStreamModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * Helper to construct and record Canonical Domain Event
 */
export const recordCanonicalDomainEvent = async ({
  travelPlanId,
  tenantId,
  sourceModule = "NotesManagement",
  aggregateType = "TravelPlan",
  aggregateId = null,
  eventType,
  title,
  description,
  actor = {},
  visibility = "Internal",
  correlationId = null,
  causationId = null,
  attachments = [],
  mentions = [],
  aiConfidenceScore = null,
  metadata = {}
}) => {
  try {
    const eventId = `EVT-${uuidv4()}`;
    const timelineEvent = await TravelTimelineModel.create({
      eventId,
      travelPlanId,
      tenantId,
      sourceModule,
      aggregateType,
      aggregateId: aggregateId || travelPlanId?.toString(),
      eventType,
      eventVersion: "1.0.0",
      title: title || eventType,
      description: description || title || eventType,
      actor: {
        userId: actor.userId || null,
        name: actor.name || "System",
        role: actor.role || "Staff"
      },
      visibility,
      correlationId: correlationId || `CORR-${travelPlanId}`,
      causationId,
      attachments,
      mentions,
      aiConfidenceScore,
      isImmutable: true,
      metadata
    });

    // Mirror to Unified Activity Stream
    await UnifiedActivityStreamModel.create({
      tenantId,
      module: sourceModule,
      referenceId: travelPlanId,
      eventType,
      title: title || eventType,
      description: description || title || eventType,
      severity: metadata.severity || "Info",
      performedBy: actor.userId,
      performedByName: actor.name || "Staff",
      metadata
    });

    return timelineEvent;
  } catch (err) {
    console.error("recordCanonicalDomainEvent Error:", err);
    return null;
  }
};

/**
 * 1. GET /api/v1/travel-plans/:travelPlanId/timeline
 * Returns the complete chronological history for a travel plan.
 */
export const GetTravelPlanTimeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!travelPlanId) {
      return sendError(res, 400, "travelPlanId is required.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, tenantId });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "20", 10), 1), 100);

    const filter = { travelPlanId, tenantId };

    if (req.query.eventType) {
      filter.eventType = req.query.eventType;
    }

    if (req.query.module || req.query.sourceModule) {
      filter.sourceModule = req.query.module || req.query.sourceModule;
    }

    if (req.query.userId) {
      filter["actor.userId"] = req.query.userId;
    }

    if (req.query.visibility) {
      filter.visibility = req.query.visibility;
    }

    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.createdAt.$lte = new Date(req.query.dateTo);
    }

    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, "i");
      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { eventType: searchRegex }
      ];
    }

    const totalItems = await TravelTimelineModel.countDocuments(filter);
    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    const timelineEvents = await TravelTimelineModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    return sendSuccess(res, 200, "Travel plan timeline retrieved successfully.", {
      data: timelineEvents,
      meta: { page, pageSize, totalItems, totalPages }
    }, requestId);
  } catch (err) {
    console.error("GetTravelPlanTimeline Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch travel plan timeline.", requestId);
  }
};

/**
 * 2. POST /api/v1/travel-plans/:travelPlanId/notes
 * Creates a collaboration note and logs canonical timeline event.
 */
export const CreateTravelNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "Staff";
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;
    const { title, content, visibility = "Internal", mentions = [] } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!title || !content) {
      return sendError(res, 400, "title and content are required.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, tenantId });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    const noteId = `NTE-${uuidv4().substring(0, 8)}`;

    const newNote = await TravelNoteModel.create({
      tenantId,
      travelPlanId,
      noteId,
      title,
      content,
      visibility,
      mentions: Array.isArray(mentions) ? mentions : [],
      authorId: userId,
      authorName: userName
    });

    // Create Timeline Event using Canonical Domain Event Model
    await recordCanonicalDomainEvent({
      travelPlanId,
      tenantId,
      sourceModule: "NotesManagement",
      aggregateType: "Note",
      aggregateId: noteId,
      eventType: "NoteCreated",
      title: `Note Created: ${title}`,
      description: content,
      actor: { userId, name: userName, role: req.auth?.role || "Staff" },
      visibility,
      mentions,
      metadata: { noteId, visibility }
    });

    if (mentions.length > 0) {
      publishEvent("UsersMentioned", {
        noteId,
        travelPlanId,
        mentionedUserIds: mentions,
        authorName: userName,
        tenantId
      });
    }

    publishEvent("NoteCreated", { noteId, travelPlanId, tenantId });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "CREATE_NOTE",
        module: "NotesManagement",
        targetId: newNote._id.toString(),
        details: { noteId, title, visibility }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Collaboration note created successfully.", newNote, requestId);
  } catch (err) {
    console.error("CreateTravelNote Error:", err);
    return sendError(res, 500, err.message || "Failed to create note.", requestId);
  }
};

/**
 * 3. PATCH /api/v1/notes/:noteId
 * Updates an existing note and preserves edit history.
 */
export const UpdateTravelNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "Staff";
    const permissions = req.auth?.permissions || [];
    const { noteId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const note = await TravelNoteModel.findOne({ noteId, tenantId, isSoftDeleted: false });
    if (!note) {
      return sendError(res, 404, "Note not found.", requestId);
    }

    // Author or Manager check
    if (note.authorId !== userId && req.auth?.role !== "Manager" && req.auth?.role !== "Administrator") {
      return sendError(res, 403, "Only the author or an authorized manager can edit this note.", requestId);
    }

    const { title, content, visibility, mentions } = req.body;

    // Record edit history
    note.editHistory.push({
      editedAt: new Date(),
      editedBy: userId,
      editedByName: userName,
      previousTitle: note.title,
      previousContent: note.content,
      previousVisibility: note.visibility
    });

    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;
    if (visibility !== undefined) note.visibility = visibility;
    if (Array.isArray(mentions)) note.mentions = mentions;

    await note.save();

    await recordCanonicalDomainEvent({
      travelPlanId: note.travelPlanId,
      tenantId,
      sourceModule: "NotesManagement",
      aggregateType: "Note",
      aggregateId: noteId,
      eventType: "NoteUpdated",
      title: `Note Updated: ${note.title}`,
      description: `Note ${noteId} updated by ${userName}`,
      actor: { userId, name: userName, role: req.auth?.role || "Staff" },
      visibility: note.visibility,
      metadata: { noteId }
    });

    publishEvent("NoteUpdated", { noteId, tenantId });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "UPDATE_NOTE",
        module: "NotesManagement",
        targetId: note._id.toString(),
        details: { noteId }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Note updated successfully.", note, requestId);
  } catch (err) {
    console.error("UpdateTravelNote Error:", err);
    return sendError(res, 500, err.message || "Failed to update note.", requestId);
  }
};

/**
 * 4. DELETE /api/v1/notes/:noteId
 * Soft deletes a note.
 */
export const DeleteTravelNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { noteId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const note = await TravelNoteModel.findOne({ noteId, tenantId, isSoftDeleted: false });
    if (!note) {
      return sendError(res, 404, "Note not found.", requestId);
    }

    note.isSoftDeleted = true;
    await note.save();

    await recordCanonicalDomainEvent({
      travelPlanId: note.travelPlanId,
      tenantId,
      sourceModule: "NotesManagement",
      aggregateType: "Note",
      aggregateId: noteId,
      eventType: "NoteDeleted",
      title: `Note Deleted: ${note.title}`,
      description: `Note ${noteId} soft deleted`,
      actor: { userId, name: req.auth?.name || "Staff" },
      visibility: "Internal",
      metadata: { noteId }
    });

    publishEvent("NoteDeleted", { noteId, tenantId });

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "DELETE_NOTE",
        module: "NotesManagement",
        targetId: note._id.toString(),
        details: { noteId }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 200, "Note soft-deleted successfully.", { noteId }, requestId);
  } catch (err) {
    console.error("DeleteTravelNote Error:", err);
    return sendError(res, 500, err.message || "Failed to delete note.", requestId);
  }
};

/**
 * 5. POST /api/v1/timeline/:timelineEventId/attachments
 * Uploads/associates attachment metadata with a timeline event.
 */
export const AddTimelineAttachment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    const { timelineEventId } = req.params;
    const { name, url, mimeType = "application/pdf", size = 0 } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!name || !url) {
      return sendError(res, 400, "name and url are required.", requestId);
    }

    const timelineEvent = await TravelTimelineModel.findOne({
      $or: [{ eventId: timelineEventId }, { _id: timelineEventId }],
      tenantId
    });

    if (!timelineEvent) {
      return sendError(res, 404, "Timeline event not found.", requestId);
    }

    const attachment = { name, url, mimeType, size, uploadedAt: new Date() };
    timelineEvent.attachments.push(attachment);
    await timelineEvent.save();

    return sendSuccess(res, 201, "Attachment added to timeline event successfully.", attachment, requestId);
  } catch (err) {
    console.error("AddTimelineAttachment Error:", err);
    return sendError(res, 500, err.message || "Failed to add attachment to timeline event.", requestId);
  }
};
