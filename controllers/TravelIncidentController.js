import EnterpriseIncidentEngineService from "../services/EnterpriseIncidentEngineService.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { saveBookingDocumentFile, resolveBookingDocumentUrl } from "../utils/fileStorage.js";
import { getIncidentConfig } from "../utils/incidentConfig.js";

const incidentConfig = getIncidentConfig();

/**
/ * 1. GET /api/v1/incidents
/ * Returns paginated incidents visible to the authenticated tenant.
/ */
export const ListIncidents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.read") && !permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("visa.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { items, pagination } = await EnterpriseIncidentEngineService.getIncidents(req.query, tenantId);

    const formattedData = items.map((inc) => ({
      incidentId: inc._id,
      incidentNumber: inc.incidentNumber,
      visaCaseId: inc.visaCaseId,
      visaCaseNumber: inc.visaCaseNumber,
      travelPlanId: inc.travelPlanId,
      sourceModule: inc.sourceModule,
      category: inc.category,
      type: inc.type,
      severity: inc.severity,
      status: inc.status,
      title: inc.title,
      description: inc.description,
      assignedTo: inc.assignedTo,
      assignedToName: inc.assignedToName,
      assignedTeam: inc.assignedTeam,
      reportedBy: inc.reportedBy,
      reportedByName: inc.reportedByName,
      // Response Includes "Priority" — was accepted as a PATCH field with
      // no real model field to persist into, and never emitted here.
      priority: inc.priority || "normal",
      location: inc.location,
      attachmentsCount: inc.attachments ? inc.attachments.length : 0,
      commentsCount: inc.comments ? inc.comments.length : 0,
      slaStatus: inc.slaStatus,
      // Response Includes "Resolution Status" — was entirely absent from the
      // list view; a caller previously had to open every incident
      // individually just to see whether it had a resolution recorded.
      resolutionStatus: ["resolved", "verified", "closed"].includes(inc.status)
        ? inc.status
        : (inc.resolution?.resolutionSummary ? "pending_verification" : "unresolved"),
      escalationLevel: inc.escalationLevel || 0,
      createdAt: inc.createdAt,
      updatedAt: inc.updatedAt
    }));

    return sendSuccess(res, 200, "Incidents retrieved successfully.", {
      data: formattedData,
      meta: pagination
    }, requestId);
  } catch (err) {
    console.error("ListIncidents Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch incidents.", requestId);
  }
};

/**
 * 2. POST /api/v1/incidents
 * Creates a new operational incident case.
 */
export const CreateIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    // This controller is shared with the Visa module via routes/IncidentRoutes.js
    // (a centralized Incident Engine), so the permission check is intentionally
    // inclusive of every module known to create incidents through it.
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const newIncident = await EnterpriseIncidentEngineService.createIncident(req.body, tenantId, branchId, userId);

    return sendSuccess(res, 201, "Incident reported successfully.", newIncident, requestId);
  } catch (err) {
    console.error("CreateIncident Error:", err);
    return sendError(res, 400, err.message || "Failed to create incident.", requestId);
  }
};

/**
 * 3. GET /api/v1/incidents/:incidentId
 * Returns complete incident case details.
 */
export const GetIncidentDetails = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.read") && !permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("visa.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const incident = await EnterpriseIncidentEngineService.getIncidentById(incidentId, tenantId);

    let travelPlan = null;
    if (incident.travelPlanId) {
      travelPlan = await TravelPlanModel.findById(incident.travelPlanId);
    }

    let timeline = [];
    if (incident.travelPlanId) {
      timeline = await TravelTimelineModel.find({ travelPlanId: incident.travelPlanId, tenantId }).sort({ createdAt: -1 }).limit(10);
    }

    // Response Includes "Audit History" — was entirely absent; AuditLogModel
    // was never queried from this endpoint. Matches both audit-log
    // conventions already coexisting in this codebase (createIncident logs
    // via targetId/module; updateIncident/assignIncident/etc. via
    // resourceId/resource) — matching only one would silently drop the
    // incident's own creation entry from its history.
    const auditHistory = await AuditLogModel.find({
      tenantId,
      $or: [
        { resourceId: incident._id.toString(), resource: "Incident" },
        { targetId: incident._id.toString(), module: "IncidentManagement" }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()
      .catch(() => []);

    // Response Includes "Related Incidents" — was entirely absent. Real
    // query, not fabricated: other open incidents sharing the same travel
    // plan or category, excluding this one.
    const relatedFilter = { tenantId, isSoftDeleted: false, _id: { $ne: incident._id } };
    relatedFilter.$or = [
      ...(incident.travelPlanId ? [{ travelPlanId: incident.travelPlanId }] : []),
      ...(incident.visaCaseId ? [{ visaCaseId: incident.visaCaseId }] : []),
      { category: incident.category }
    ];
    const relatedIncidents = relatedFilter.$or.length > 0
      ? await TravelIncidentManagementModel.find(relatedFilter)
        .select("incidentNumber title category severity status createdAt")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
      : [];

    const fullAggregate = {
      header: incident,
      travelPlanSummary: travelPlan ? { travelPlanNumber: travelPlan.travelPlanNumber, bookingNumber: travelPlan.bookingNumber } : null,
      reporter: { reportedBy: incident.reportedBy, reportedByName: incident.reportedByName },
      assignee: { assignedTo: incident.assignedTo, assignedToName: incident.assignedToName, assignedTeam: incident.assignedTeam },
      timeline,
      investigation: incident.investigation,
      caseHistory: incident.comments,
      tasks: incident.tasks,
      attachments: incident.attachments,
      resolution: incident.resolution,
      slaStatus: incident.slaStatus,
      auditHistory,
      relatedIncidents
    };

    return sendSuccess(res, 200, "Incident details retrieved successfully.", fullAggregate, requestId);
  } catch (err) {
    console.error("GetIncidentDetails Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 500, err.message || "Failed to fetch incident details.", requestId);
  }
};

/**
 * 4. PATCH /api/v1/incidents/:incidentId
 * Updates incident information.
 */
export const UpdateIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const updated = await EnterpriseIncidentEngineService.updateIncident(incidentId, req.body, tenantId, userId, permissions);
    return sendSuccess(res, 200, "Incident updated successfully.", updated, requestId);
  } catch (err) {
    console.error("UpdateIncident Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to update incident.", requestId);
  }
};

/**
 * 5. POST /api/v1/incidents/:incidentId/assign
 * Assigns responsibility for handling an incident.
 */
export const AssignIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;
    const { userId: assigneeId, userName: assigneeName, team = "Operations" } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const assigned = await EnterpriseIncidentEngineService.assignIncident(
      incidentId,
      { assigneeId: assigneeId || req.body.assignedTo, assigneeName: assigneeName || req.body.assignedToName, team },
      tenantId,
      userId
    );

    return sendSuccess(res, 200, "Incident assigned successfully.", assigned, requestId);
  } catch (err) {
    console.error("AssignIncident Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to assign incident.", requestId);
  }
};

/**
 * 6. POST /api/v1/incidents/:incidentId/resolve
 * Marks an incident as resolved with root cause and CAPA.
 */
export const ResolveIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const resolved = await EnterpriseIncidentEngineService.resolveIncident(incidentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Incident resolved successfully.", resolved, requestId);
  } catch (err) {
    console.error("ResolveIncident Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to resolve incident.", requestId);
  }
};

/**
 * 7. POST /api/v1/incidents/:incidentId/investigation/evidence
 * Attaches investigation evidence to incident.
 */
export const AddIncidentEvidence = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const evidence = await EnterpriseIncidentEngineService.addEvidence(incidentId, req.body, tenantId, userId);
    return sendSuccess(res, 201, "Investigation evidence attached successfully.", evidence, requestId);
  } catch (err) {
    console.error("AddIncidentEvidence Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to attach evidence.", requestId);
  }
};

/**
 * 8. POST /api/v1/incidents/:incidentId/verify
 * Verifies resolution of an incident.
 */
export const VerifyIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const verified = await EnterpriseIncidentEngineService.verifyIncident(incidentId, tenantId, userId);
    return sendSuccess(res, 200, "Incident resolution verified successfully.", verified, requestId);
  } catch (err) {
    console.error("VerifyIncident Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to verify incident.", requestId);
  }
};

/**
 * 9. POST /api/v1/incidents/:incidentId/close
 * Closes incident.
 */
export const CloseIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const closed = await EnterpriseIncidentEngineService.closeIncident(incidentId, tenantId, userId);
    return sendSuccess(res, 200, "Incident closed successfully.", closed, requestId);
  } catch (err) {
    console.error("CloseIncident Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to close incident.", requestId);
  }
};

/**
 * 10. POST /api/v1/incidents/:incidentId/reopen
 * Reopens closed incident.
 */
export const ReopenIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;
    const { reason } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const reopened = await EnterpriseIncidentEngineService.reopenIncident(incidentId, reason, tenantId, userId);
    return sendSuccess(res, 200, "Incident reopened successfully.", reopened, requestId);
  } catch (err) {
    console.error("ReopenIncident Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to reopen incident.", requestId);
  }
};

/**
 * 11. POST /api/v1/incidents/:incidentId/attachments
 */
export const AddIncidentAttachment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;
    const { name, url, storageKey, mimeType = "application/pdf", size = 0, fileBuffer, fileBase64 } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    if (!name) {
      return sendError(res, 400, "name is required.", requestId);
    }
    if (!url && !storageKey && !fileBuffer && !fileBase64) {
      return sendError(res, 400, "Provide fileBuffer/fileBase64 to upload, or an existing url/storageKey.", requestId);
    }

    // AI Coding Rule "Object Storage" — was previously a fake pass-through:
    // whatever `url` the client claimed was trusted as-is, with no upload
    // handling, no MIME-type allowlist, no size limit. Reuses the same
    // real, already-proven multi-provider (Cloudinary/S3/local) storage
    // abstraction Booking Documents use, instead of duplicating it.
    if (mimeType && !incidentConfig.attachmentAllowedMimeTypes.includes(mimeType)) {
      return sendError(res, 400, `Unsupported file type '${mimeType}'. Allowed: ${incidentConfig.attachmentAllowedMimeTypes.join(", ")}.`, requestId);
    }

    let resolvedStorageKey = storageKey || null;
    let resolvedUrl = url ? resolveBookingDocumentUrl(url) : null;
    let resolvedSize = Number(size) || 0;

    if (!resolvedUrl && !resolvedStorageKey && (fileBuffer || fileBase64)) {
      const buffer = fileBuffer ? Buffer.from(fileBuffer) : Buffer.from(fileBase64, "base64");
      if (buffer.length > incidentConfig.attachmentMaxSizeBytes) {
        return sendError(res, 400, `File exceeds the maximum allowed size of ${incidentConfig.attachmentMaxSizeBytes} bytes.`, requestId);
      }
      const storageResult = await saveBookingDocumentFile({
        fileName: name,
        mimeType,
        buffer,
        extension: mimeType.includes("pdf") ? ".pdf" : mimeType.includes("image") ? ".png" : mimeType.includes("video") ? ".mp4" : ".bin"
      });
      resolvedUrl = storageResult.publicUrl;
      resolvedStorageKey = storageResult.storedFileName;
      resolvedSize = buffer.length;
    }

    const incident = await TravelIncidentManagementModel.findOne({ _id: incidentId, tenantId, isSoftDeleted: false });
    if (!incident) {
      return sendError(res, 404, "Incident case not found.", requestId);
    }

    const attachment = {
      name,
      url: resolvedUrl || url,
      storageKey: resolvedStorageKey,
      mimeType,
      size: resolvedSize,
      uploadedBy: userId,
      uploadedAt: new Date()
    };
    incident.attachments.push(attachment);
    await incident.save();

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_INCIDENT_ATTACHMENT",
        module: "IncidentManagement",
        targetId: incident._id.toString(),
        details: { name, mimeType, size: resolvedSize }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Attachment added successfully.", attachment, requestId);
  } catch (err) {
    console.error("AddIncidentAttachment Error:", err);
    return sendError(res, 500, err.message || "Failed to add attachment.", requestId);
  }
};

/**
 * 12. POST /api/v1/incidents/:incidentId/comments
 */
export const AddIncidentComment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;
    const { text } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    if (!text) {
      return sendError(res, 400, "Comment text is required.", requestId);
    }

    const incident = await TravelIncidentManagementModel.findOne({ _id: incidentId, tenantId, isSoftDeleted: false });
    if (!incident) {
      return sendError(res, 404, "Incident case not found.", requestId);
    }

    const comment = {
      authorId: userId,
      authorName: req.auth?.name || "Staff",
      text,
      createdAt: new Date()
    };

    incident.comments.push(comment);
    await incident.save();

    try {
      await AuditLogModel.create({
        tenantId,
        userId,
        action: "ADD_INCIDENT_COMMENT",
        module: "IncidentManagement",
        targetId: incident._id.toString(),
        details: { text }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Comment added successfully.", comment, requestId);
  } catch (err) {
    console.error("AddIncidentComment Error:", err);
    return sendError(res, 500, err.message || "Failed to add comment.", requestId);
  }
};

/**
 * 13. POST /api/v1/incidents/:incidentId/tasks
 */
export const AddIncidentTask = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;
    const { description, assignedTo, dueDate } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    if (!description) {
      return sendError(res, 400, "Task description is required.", requestId);
    }

    const incident = await TravelIncidentManagementModel.findOne({ _id: incidentId, tenantId, isSoftDeleted: false });
    if (!incident) {
      return sendError(res, 404, "Incident case not found.", requestId);
    }

    const task = {
      taskId: `TSK-${Date.now()}`,
      description,
      assignedTo: assignedTo || null,
      isCompleted: false,
      dueDate: dueDate ? new Date(dueDate) : null
    };

    incident.tasks.push(task);
    await incident.save();

    try {
      await AuditLogModel.create({
        tenantId,
        userId: req.auth?.userId || req.auth?.id || "system",
        action: "ADD_INCIDENT_TASK",
        module: "IncidentManagement",
        targetId: incident._id.toString(),
        details: { description, assignedTo: assignedTo || null }
      });
    } catch (auditErr) {
      console.error("Audit log error:", auditErr);
    }

    return sendSuccess(res, 201, "Task added successfully.", task, requestId);
  } catch (err) {
    console.error("AddIncidentTask Error:", err);
    return sendError(res, 500, err.message || "Failed to add task.", requestId);
  }
};

/**
 * 14. POST /api/v1/incidents/:incidentId/investigation
 */
export const UpdateIncidentInvestigation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const permissions = req.auth?.permissions || [];
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.write") && !permissions.includes("travel.write") && !permissions.includes("travel_plans.write") && !permissions.includes("visa.write") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const investigation = await EnterpriseIncidentEngineService.updateInvestigation(incidentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Investigation updated successfully.", investigation, requestId);
  } catch (err) {
    console.error("UpdateIncidentInvestigation Error:", err);
    return sendError(res, err.message?.includes("not found") ? 404 : 400, err.message || "Failed to update investigation.", requestId);
  }
};

/**
 * 15. GET /api/v1/incidents/analytics
 */
export const GetIncidentAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("incidents.read") && !permissions.includes("travel.read") && !permissions.includes("travel_plans.read") && !permissions.includes("visa.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const analytics = await EnterpriseIncidentEngineService.getIncidentAnalytics(tenantId);
    return sendSuccess(res, 200, "Incident analytics and AI trend insights retrieved successfully.", analytics, requestId);
  } catch (err) {
    console.error("GetIncidentAnalytics Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch incident analytics.", requestId);
  }
};
