import { v4 as uuidv4 } from "uuid";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import TravelNoteModel from "../models/TravelNoteModel.js";
import UnifiedActivityStreamModel from "../models/UnifiedActivityStreamModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { saveBookingDocumentFile, resolveBookingDocumentUrl } from "../utils/fileStorage.js";
import { getNotesTimelineConfig } from "../utils/notesTimelineConfig.js";
import { getAccessScope } from "../utils/accessScope.js";

const notesTimelineConfig = getNotesTimelineConfig();

// "Only author or authorized manager may edit" — the previous check used
// req.auth?.role (singular), a field that is essentially never populated on
// this codebase's real JWT payload (confirmed: every other module reads
// req.auth?.roles, a plural array, or req.auth?.permissions; a grep across
// controllers/services turns up no other reliable writer of a singular
// `role` string). That meant the "or manager" half of the rule silently
// never fired — only the literal author could ever edit or delete a note.
// Uses the same admin-elevation convention already established everywhere
// else in this session.
const isAuthorOrManager = (note, userId, permissions) => note.authorId === userId || (permissions || []).includes("admin");

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

    // Note: publish the Mongo _id, not the human-readable eventId field —
    // SearchEngineService.indexTimelineEvent looks the document up by _id.
    publishEvent("TimelineEventCreated", { tenantId, eventId: timelineEvent._id.toString() });

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
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!travelPlanId) {
      return sendError(res, 400, "travelPlanId is required.", requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
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

    // "Private" is the one visibility level with an unambiguous
    // access-control meaning (the other four — Internal/Operations/
    // Management/Customer Visible — read as categorization tags, not a
    // documented access matrix, so they aren't enforced here). Was
    // previously not enforced at all: any user with travel.read could see
    // every entry, including ones explicitly marked Private.
    if (!permissions.includes("admin")) {
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ visibility: { $ne: "Private" } }, { "actor.userId": userId }] }
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
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "Staff";
    const permissions = req.auth?.permissions || [];
    const { travelPlanId } = req.params;
    const { title, content, visibility = "Internal", mentions = [] } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!title || !content) {
      return sendError(res, 400, "title and content are required.", requestId);
    }

    // Validation Rule: "Visibility Valid" — was previously unchecked,
    // relying only on Mongoose's own enum validation (a raw ValidationError
    // caught by the generic catch and turned into an opaque 500).
    if (!notesTimelineConfig.visibilityOptions.includes(visibility)) {
      return sendError(res, 400, `Invalid visibility '${visibility}'. Must be one of: ${notesTimelineConfig.visibilityOptions.join(", ")}.`, requestId);
    }

    const travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, ...scope });
    if (!travelPlan) {
      return sendError(res, 404, "Travel plan not found.", requestId);
    }

    // Validation Rule: "Mentioned Users Exist" — was previously not
    // validated at all; mentions were stored as raw, unverified strings.
    // Resolved against EmployeeProfileModel (mentions are internal staff
    // pings, matching the "Notify Mentioned Users" workflow step below),
    // same catalog used for Booking's "Consultant Exists"/Travel Plan's
    // "Coordinator Exists" checks earlier this session.
    if (Array.isArray(mentions) && mentions.length > 0) {
      const mentionedStaff = await EmployeeProfileModel.find({
        tenantId, status: { $ne: "archived" },
        $or: [{ _id: { $in: mentions } }, { identityId: { $in: mentions } }]
      }).select("_id identityId").lean();
      const resolvedIds = new Set(mentionedStaff.flatMap((e) => [e._id.toString(), e.identityId].filter(Boolean)));
      const missing = mentions.filter((m) => !resolvedIds.has(m.toString()));
      if (missing.length > 0) {
        return sendError(res, 422, `Mentioned user(s) do not exist: ${missing.join(", ")}.`, requestId);
      }
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
      // Business Workflow: "Notify Mentioned Users."
      publishEvent("NotificationRequested", {
        tenantId,
        event: "UsersMentioned",
        recipientIds: mentions,
        travelPlanId,
        noteId,
        authorName: userName
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
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const userName = req.auth?.name || "Staff";
    const permissions = req.auth?.permissions || [];
    const { noteId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const note = await TravelNoteModel.findOne({ noteId, tenantId, isSoftDeleted: false });
    if (!note) {
      return sendError(res, 404, "Note not found.", requestId);
    }

    if (!isAuthorOrManager(note, userId, permissions)) {
      return sendError(res, 403, "Only the author or an authorized manager can edit this note.", requestId);
    }

    const { title, content, visibility, mentions } = req.body;

    if (visibility !== undefined && !notesTimelineConfig.visibilityOptions.includes(visibility)) {
      return sendError(res, 400, `Invalid visibility '${visibility}'. Must be one of: ${notesTimelineConfig.visibilityOptions.join(", ")}.`, requestId);
    }

    if (Array.isArray(mentions) && mentions.length > 0) {
      const mentionedStaff = await EmployeeProfileModel.find({
        tenantId, status: { $ne: "archived" },
        $or: [{ _id: { $in: mentions } }, { identityId: { $in: mentions } }]
      }).select("_id identityId").lean();
      const resolvedIds = new Set(mentionedStaff.flatMap((e) => [e._id.toString(), e.identityId].filter(Boolean)));
      const missing = mentions.filter((m) => !resolvedIds.has(m.toString()));
      if (missing.length > 0) {
        return sendError(res, 422, `Mentioned user(s) do not exist: ${missing.join(", ")}.`, requestId);
      }
    }

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
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id;
    const permissions = req.auth?.permissions || [];
    const { noteId } = req.params;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const note = await TravelNoteModel.findOne({ noteId, tenantId, isSoftDeleted: false });
    if (!note) {
      return sendError(res, 404, "Note not found.", requestId);
    }

    // PATCH's doc section explicitly restricts edits to "author or
    // authorized manager"; DELETE's own section doesn't repeat the phrase,
    // but leaving delete completely unrestricted — any user with
    // travel.write could delete anyone else's note — would be a glaring,
    // almost certainly unintended inconsistency with PATCH's own rule for
    // the identical resource. Applied the same restriction here.
    if (!isAuthorOrManager(note, userId, permissions)) {
      return sendError(res, 403, "Only the author or an authorized manager can delete this note.", requestId);
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
    const scope = getAccessScope(req);
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { timelineEventId } = req.params;
    const { name, url, storageKey, mimeType = "application/pdf", size = 0, fileBuffer, fileBase64 } = req.body;

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    if (!name) {
      return sendError(res, 400, "name is required.", requestId);
    }
    if (!url && !storageKey && !fileBuffer && !fileBase64) {
      return sendError(res, 400, "Provide fileBuffer/fileBase64 to upload, or an existing url/storageKey.", requestId);
    }

    // AI Coding Rule "Object Storage" — was previously a fake pass-through
    // trusting any client-supplied url, no upload handling, no MIME-type
    // allowlist. Reuses the same real, already-proven multi-provider
    // (Cloudinary/S3/local) storage abstraction used for Booking Documents
    // and (this Part) Incident attachments.
    if (mimeType && !notesTimelineConfig.attachmentAllowedMimeTypes.includes(mimeType)) {
      return sendError(res, 400, `Unsupported file type '${mimeType}'. Allowed: ${notesTimelineConfig.attachmentAllowedMimeTypes.join(", ")}.`, requestId);
    }

    let resolvedStorageKey = storageKey || null;
    let resolvedUrl = url ? resolveBookingDocumentUrl(url) : null;
    let resolvedSize = Number(size) || 0;

    if (!resolvedUrl && !resolvedStorageKey && (fileBuffer || fileBase64)) {
      const buffer = fileBuffer ? Buffer.from(fileBuffer) : Buffer.from(fileBase64, "base64");
      if (buffer.length > notesTimelineConfig.attachmentMaxSizeBytes) {
        return sendError(res, 400, `File exceeds the maximum allowed size of ${notesTimelineConfig.attachmentMaxSizeBytes} bytes.`, requestId);
      }
      const storageResult = await saveBookingDocumentFile({
        fileName: name,
        mimeType,
        buffer,
        extension: mimeType.includes("pdf") ? ".pdf" : mimeType.includes("image") ? ".png" : mimeType.includes("video") ? ".mp4" : mimeType.includes("audio") ? ".mp3" : ".bin"
      });
      resolvedUrl = storageResult.publicUrl;
      resolvedStorageKey = storageResult.storedFileName;
      resolvedSize = buffer.length;
    }

    const timelineEvent = await TravelTimelineModel.findOne({
      $or: [{ eventId: timelineEventId }, { _id: timelineEventId }],
      tenantId
    });

    if (!timelineEvent) {
      return sendError(res, 404, "Timeline event not found.", requestId);
    }

    const attachment = {
      name,
      url: resolvedUrl || url,
      storageKey: resolvedStorageKey,
      mimeType,
      size: resolvedSize,
      uploadedAt: new Date()
    };
    timelineEvent.attachments.push(attachment);
    await timelineEvent.save();

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_TIMELINE_ATTACHMENT",
        module: "NotesManagement",
        targetId: timelineEvent._id.toString(),
        details: { name, mimeType, size: resolvedSize }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Attachment added to timeline event successfully.", attachment, requestId);
  } catch (err) {
    console.error("AddTimelineAttachment Error:", err);
    return sendError(res, 500, err.message || "Failed to add attachment to timeline event.", requestId);
  }
};
