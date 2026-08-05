import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import UnifiedActivityStreamModel from "../models/UnifiedActivityStreamModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import SearchEngineService from "./SearchEngineService.js";
import TimelinePolicyModel from "../models/TimelinePolicyModel.js";

class EnterpriseTimelineEngineService {
  static async getPolicy(tenantId) {
    if (mongoose.connection?.readyState !== 1) return null;
    const policy = await TimelinePolicyModel.findOne({ tenantId, isActive: true }).lean();
    if (!policy) throw new Error("No active timeline policy is configured for this tenant.");
    return policy;
  }
  /**
   * 1. RECORD IMMUTABLE TIMELINE EVENT
   */
  static async recordEvent({
    tenantId,
    branchId = "main",
    visaCaseId = null,
    travelPlanId = null,
    sourceModule = "VisaManagement",
    aggregateType = "VisaCase",
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
    metadata = {},
    visaCase = null
  }) {
    try {
      const eventId = `EVT-${uuidv4()}`;

      let resolvedVisaCase = visaCase;
      if (visaCaseId && !resolvedVisaCase && mongoose.connection && mongoose.connection.readyState === 1) {
        resolvedVisaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId }).catch(() => null);
      }

      const timelineEvent = new TravelTimelineModel({
        eventId,
        visaCaseId: resolvedVisaCase ? resolvedVisaCase._id : (visaCaseId || null),
        travelPlanId,
        tenantId,
        branchId,
        sourceModule,
        aggregateType,
        aggregateId: aggregateId || (resolvedVisaCase ? resolvedVisaCase._id.toString() : (visaCaseId ? visaCaseId.toString() : null)),
        eventType,
        eventVersion: "1.0.0",
        title: title || eventType,
        description: description || title || eventType,
        actor: {
          userId: actor.userId || null,
          name: actor.name || "System",
          role: actor.role || "System"
        },
        visibility,
        correlationId: correlationId || (visaCaseId ? `CORR-VISA-${visaCaseId}` : `CORR-SYS-${Date.now()}`),
        causationId,
        attachments,
        mentions,
        isImmutable: true,
        metadata
      });

      if (mongoose.connection && mongoose.connection.readyState === 1) {
        await timelineEvent.save();

        // Mirror to Unified Activity Stream
        await UnifiedActivityStreamModel.create({
          tenantId,
          branchId,
          module: sourceModule.includes("Visa") ? "Visa" : sourceModule,
          referenceId: resolvedVisaCase ? resolvedVisaCase._id : (visaCaseId || travelPlanId || null),
          eventType,
          title: title || eventType,
          description: description || title || eventType,
          severity: metadata.severity || "Info",
          performedBy: actor.userId,
          performedByName: actor.name || "System",
          metadata
        }).catch(err => console.error("UnifiedActivityStream error:", err));
      }

      // Also append to VisaCase embedded timeline array for fast lookups
      if (resolvedVisaCase) {
        resolvedVisaCase.timeline = Array.isArray(resolvedVisaCase.timeline) ? resolvedVisaCase.timeline : [];
        resolvedVisaCase.timeline.push({
          event: eventType,
          description: `${title}: ${description}`,
          performedBy: actor.userId || "system",
          timestamp: new Date()
        });
        if (typeof resolvedVisaCase.save === "function") {
          await resolvedVisaCase.save();
        }
      }

      // Publish Domain Event
      publishEvent("TimelineEventCreated", {
        eventId,
        eventType,
        visaCaseId: resolvedVisaCase ? resolvedVisaCase._id : visaCaseId,
        tenantId
      });

      // The timeline is independently searchable; failures here must never
      // invalidate the business action that produced the event.
      if (mongoose.connection?.readyState === 1) {
        await SearchEngineService.indexEntity({
          tenantId,
          branchId,
          entityType: "TimelineEvent",
          entityId: eventId,
          title: timelineEvent.title,
          description: timelineEvent.description,
          keywords: [eventType, sourceModule, aggregateType, ...(metadata.tags || [])],
          matchedFields: [
            { field: "Event type", value: eventType },
            { field: "Module", value: sourceModule },
            { field: "Actor", value: timelineEvent.actor.name || "System" }
          ],
          module: "Timeline",
          navigationUrl: visaCaseId ? `/visa-cases/${visaCaseId}/timeline/${eventId}` : `/timeline/${eventId}`
        });
        publishEvent("TimelineIndexed", { eventId, tenantId, branchId });
      }

      return timelineEvent;
    } catch (err) {
      console.error("EnterpriseTimelineEngineService.recordEvent Error:", err);
      return null;
    }
  }

  /**
   * 2. RECORD MANUAL OPERATIONAL NOTE
   */
  static async recordManualNote({
    visaCaseId,
    noteType = "Internal",
    text,
    visibility = "Internal",
    mentions = [],
    attachments = [],
    isPrivate = false,
    tenantId,
    branchId = "main",
    userId,
    userName = "Staff",
    userRole = "Staff",
    requestContext = {},
    visaCase = null
  }) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Note text is required.");
    }
    const policy = await this.getPolicy(tenantId);
    const maxNoteLength = policy?.maxNoteLength || 5000;
    if (text.trim().length > maxNoteLength) {
      throw new Error(`Note text cannot exceed ${maxNoteLength} characters.`);
    }
    if (policy && !policy.noteTypes.includes(noteType)) {
      throw new Error("Note type is not active in the tenant timeline policy.");
    }
    if (policy && !policy.visibilityLevels.includes(isPrivate ? "Private" : visibility)) {
      throw new Error("Visibility level is not active in the tenant timeline policy.");
    }

    let resolvedVisaCase = visaCase;
    if (visaCaseId && !resolvedVisaCase && mongoose.connection && mongoose.connection.readyState === 1) {
      resolvedVisaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId });
      if (!resolvedVisaCase) {
        throw new Error(`Visa Case ${visaCaseId} not found.`);
      }
    }

    const noteId = `NTE-${uuidv4().substring(0, 8)}`;
    const effectiveVisibility = isPrivate ? "Private" : visibility;

    // Push to embedded notes if visaCase is available
    if (resolvedVisaCase) {
      resolvedVisaCase.notes = Array.isArray(resolvedVisaCase.notes) ? resolvedVisaCase.notes : [];
      resolvedVisaCase.notes.push({
        noteText: `[${noteType}] ${text}`,
        isInternal: effectiveVisibility !== "Public" && effectiveVisibility !== "Customer Visible",
        createdBy: userId || "system",
        createdAt: new Date()
      });
      if (typeof resolvedVisaCase.save === "function") {
        await resolvedVisaCase.save();
      }
    }

    // Record Immutable Timeline Event
    const timelineEvent = await this.recordEvent({
      tenantId,
      branchId,
      visaCaseId: resolvedVisaCase ? resolvedVisaCase._id : visaCaseId,
      sourceModule: "NotesManagement",
      aggregateType: "Note",
      aggregateId: noteId,
      eventType: "ManualNoteCreated",
      title: `[${noteType}] Operational Note`,
      description: text.trim(),
      actor: { userId, name: userName, role: userRole },
      visibility: effectiveVisibility,
      attachments,
      mentions,
      metadata: { noteId, noteType, isPrivate, ...requestContext },
      visaCase: resolvedVisaCase
    });

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      await AuditLogModel.create({
        tenantId,
        userId: userId || "system",
        action: "CREATE_MANUAL_NOTE",
        outcome: "success",
        requestId: requestContext.requestId || `timeline-${noteId}`,
        branchId,
        ipAddress: requestContext.ipAddress || null,
        metadata: { visaCaseId: resolvedVisaCase ? resolvedVisaCase._id : visaCaseId, noteId, noteType, visibility: effectiveVisibility }
      }).catch(err => console.error("AuditLog error:", err));
    }

    publishEvent("ManualNoteCreated", { noteId, visaCaseId: resolvedVisaCase ? resolvedVisaCase._id : visaCaseId, tenantId });
    publishEvent("NoteCreated", { noteId, visaCaseId: resolvedVisaCase ? resolvedVisaCase._id : visaCaseId, tenantId });

    return {
      noteId,
      noteType,
      text,
      visibility: effectiveVisibility,
      attachments,
      mentions,
      timelineEventId: timelineEvent ? timelineEvent.eventId : null,
      createdAt: new Date()
    };
  }

  /**
   * 3. GET TIMELINE (Paginated & Filtered)
   */
  static async getTimeline(query, tenantId, requester = {}) {
    const page = Math.max(parseInt(query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize || "20", 10), 1), 100);

    let items = [];
    let totalItems = 0;

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const filter = { tenantId, archivedAt: null };

      if (query.visaCaseId) filter.visaCaseId = query.visaCaseId;
      if (query.travelPlanId) filter.travelPlanId = query.travelPlanId;
      if (query.branchId) filter.branchId = query.branchId;
      if (query.eventType) filter.eventType = query.eventType;
      if (query.module || query.sourceModule) filter.sourceModule = query.module || query.sourceModule;
      if (query.performedBy) filter["actor.userId"] = query.performedBy;
      if (query.visibility) filter.visibility = query.visibility;

      if (query.dateFrom || query.dateTo) {
        filter.createdAt = {};
        if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
        if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
      }

      if (query.search) {
        const searchRegex = new RegExp(query.search, "i");
        filter.$or = [
          { title: searchRegex },
          { description: searchRegex },
          { eventType: searchRegex }
        ];
      }

      // "Visibility Rules... Private" — was previously unenforced: any
      // caller with read access could see every entry, including notes
      // marked Private by another user. Mirrors the same access-control
      // carve-out already applied to Travel Plan timelines.
      if (!requester.isAdmin) {
        filter.$and = [
          ...(filter.$and || []),
          { $or: [{ visibility: { $ne: "Private" } }, { "actor.userId": requester.userId || null }] }
        ];
      }

      const sortOrder = query.order === "asc" ? 1 : -1;

      const [fetchedItems, count] = await Promise.all([
        TravelTimelineModel.find(filter)
          .sort({ createdAt: sortOrder })
          .skip((page - 1) * pageSize)
          .limit(pageSize),
        TravelTimelineModel.countDocuments(filter)
      ]);
      items = fetchedItems;
      totalItems = count;
    }

    return {
      items,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize) || 1
      }
    };
  }

  /**
   * 4. GET SINGLE TIMELINE EVENT BY ID
   */
  static async getEventById(eventId, tenantId) {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const event = await TravelTimelineModel.findOne({
        $or: [{ eventId }, { _id: mongoose.Types.ObjectId.isValid(eventId) ? eventId : null }],
        tenantId
      });

      if (!event) {
        throw new Error("Timeline event not found.");
      }
      return event;
    }

    return {
      eventId,
      title: "Mock Event",
      description: "Mock event details for test",
      eventType: "MockEvent",
      actor: { name: "Staff" }
    };
  }

  /**
   * 4b. GET SINGLE TIMELINE EVENT DETAIL — event + Related Records + Audit Summary.
   * Doc's Response Includes for GET /timeline/{eventId} go beyond the raw
   * event (comments/attachments/metadata already on the model) to also call
   * for "Related Records" and an "Audit Summary" — neither was assembled
   * anywhere; the endpoint just returned the bare document.
   */
  static async getEventDetail(eventId, tenantId) {
    const event = await this.getEventById(eventId, tenantId);
    const plainEvent = typeof event.toObject === "function" ? event.toObject() : event;

    let auditSummary = [];
    if (mongoose.connection?.readyState === 1) {
      const idCandidates = [eventId];
      if (event._id) idCandidates.push(event._id.toString());
      if (event.eventId) idCandidates.push(event.eventId);

      auditSummary = await AuditLogModel.find({
        tenantId,
        $or: [
          { resourceId: { $in: idCandidates } },
          { targetId: { $in: idCandidates } }
        ]
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("action module resource userId createdAt details")
        .lean();
    }

    return {
      ...plainEvent,
      relatedRecords: {
        visaCaseId: plainEvent.visaCaseId || null,
        travelPlanId: plainEvent.travelPlanId || null,
        aggregateType: plainEvent.aggregateType || null,
        aggregateId: plainEvent.aggregateId || null
      },
      auditSummary
    };
  }

  /** Events are never edited or deleted. Archiving only changes discoverability. */
  static async archiveEvent(eventId, tenantId, userId) {
    const event = await this.getEventById(eventId, tenantId);
    event.archivedAt = new Date();
    event.archivedBy = userId || "system";
    await event.save();
    publishEvent("TimelineArchived", { eventId: event.eventId, tenantId, archivedBy: userId || "system" });
    return event;
  }

  /**
   * 5. ADD COMMENT TO TIMELINE EVENT
   */
  static async addCommentToEvent(eventId, { text }, tenantId, userId, userName = "Staff") {
    if (!text) {
      throw new Error("Comment text is required.");
    }

    const event = await this.getEventById(eventId, tenantId);

    const comment = {
      commentId: `CMT-${uuidv4().substring(0, 8)}`,
      authorId: userId,
      authorName: userName,
      text,
      createdAt: new Date()
    };

    if (!event.comments) event.comments = [];
    event.comments.push(comment);

    if (typeof event.save === "function") {
      await event.save();
    }

    publishEvent("TimelineCommentAdded", { eventId, commentId: comment.commentId, tenantId });

    return comment;
  }

  /**
   * 6. ADD ATTACHMENT TO TIMELINE EVENT
   */
  static async addAttachmentToEvent(eventId, { name, url, mimeType = "application/pdf", size = 0 }, tenantId, userId) {
    if (!name || !url) {
      throw new Error("Attachment name and url are required.");
    }

    const event = await this.getEventById(eventId, tenantId);

    const attachment = { name, url, mimeType, size, uploadedAt: new Date() };

    if (!event.attachments) event.attachments = [];
    event.attachments.push(attachment);

    if (typeof event.save === "function") {
      await event.save();
    }

    publishEvent("TimelineAttachmentAdded", { eventId, attachmentName: name, tenantId });

    return attachment;
  }

  /**
   * 7. BUILD AI CONTEXT PROVIDER FOR VISA CASE
   */
  static async buildAIContext(visaCaseId, tenantId) {
    let visaCase = null;
    let timelineEvents = [];

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId });
      timelineEvents = await TravelTimelineModel.find({ visaCaseId, tenantId }).sort({ createdAt: 1 }).limit(100);
    }

    const summaryText = visaCase
      ? `Visa Case ${visaCase.caseNumber} (${visaCase.destinationCountry} - ${visaCase.visaType}). Current Status: ${visaCase.status}. Priority: ${visaCase.priority}. Is Locked: ${visaCase.isLocked ? "YES (" + visaCase.lockReason + ")" : "NO"}.`
      : `Visa Case ID ${visaCaseId}`;

    const timelineSummary = timelineEvents.map(e => `- [${e.createdAt.toISOString()}] (${e.sourceModule}/${e.eventType}): ${e.title} - ${e.description}`).join("\n");

    const pendingActions = [];
    if (visaCase && visaCase.requiredDocuments) {
      const pendingDocs = visaCase.requiredDocuments.filter(d => d.status === "pending");
      if (pendingDocs.length > 0) {
        pendingActions.push(`Pending Documents: ${pendingDocs.map(d => d.title).join(", ")}`);
      }
    }
    if (visaCase && visaCase.incidents) {
      const openIncidents = visaCase.incidents.filter(i => i.status === "open" || i.status === "investigating");
      if (openIncidents.length > 0) {
        pendingActions.push(`Open Incidents: ${openIncidents.map(i => "[" + i.severity + "] " + i.title).join("; ")}`);
      }
    }

    return {
      visaCaseId,
      caseSummary: summaryText,
      chronologicalHistory: timelineSummary || "No timeline events recorded yet.",
      pendingActions: pendingActions.length > 0 ? pendingActions : ["No blocking actions pending."],
      aiPromptContext: `CASE CONTEXT:\n${summaryText}\n\nPENDING ACTIONS:\n${pendingActions.join("\n")}\n\nTIMELINE HISTORY:\n${timelineSummary}`
    };
  }
}

export default EnterpriseTimelineEngineService;
