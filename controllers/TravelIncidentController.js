import EnterpriseIncidentEngineService from "../services/EnterpriseIncidentEngineService.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

/**
/ * 1. GET /api/v1/incidents
/ * Returns paginated incidents visible to the authenticated tenant.
/ */
export const ListIncidents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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
      severity: inc.severity,
      status: inc.status,
      title: inc.title,
      description: inc.description,
      assignedTo: inc.assignedTo,
      assignedToName: inc.assignedToName,
      assignedTeam: inc.assignedTeam,
      reportedBy: inc.reportedBy,
      reportedByName: inc.reportedByName,
      location: inc.location,
      attachmentsCount: inc.attachments ? inc.attachments.length : 0,
      commentsCount: inc.comments ? inc.comments.length : 0,
      slaStatus: inc.slaStatus,
      createdAt: inc.createdAt,
      updatedAt: inc.updatedAt
    }));

    return res.status(200).json({
      success: true,
      data: formattedData,
      meta: pagination,
      requestId
    });
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
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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

    const fullAggregate = {
      header: incident,
      travelPlanSummary: travelPlan ? { travelPlanNumber: travelPlan.travelPlanNumber, bookingNumber: travelPlan.bookingNumber } : null,
      timeline,
      investigation: incident.investigation,
      caseHistory: incident.comments,
      tasks: incident.tasks,
      attachments: incident.attachments,
      resolution: incident.resolution,
      slaStatus: incident.slaStatus
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
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    const updated = await EnterpriseIncidentEngineService.updateIncident(incidentId, req.body, tenantId, userId);
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
    const { incidentId } = req.params;
    const { userId: assigneeId, userName: assigneeName, team = "Operations" } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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
    const { incidentId } = req.params;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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
    const { incidentId } = req.params;

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
    const { incidentId } = req.params;

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
    const { incidentId } = req.params;
    const { reason } = req.body;

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
    const { incidentId } = req.params;
    const { name, url, mimeType = "application/pdf", size = 0 } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!name || !url) {
      return sendError(res, 400, "name and url are required.", requestId);
    }

    const incident = await TravelIncidentManagementModel.findOne({ _id: incidentId, tenantId, isSoftDeleted: false });
    if (!incident) {
      return sendError(res, 404, "Incident case not found.", requestId);
    }

    const attachment = { name, url, mimeType, size, uploadedAt: new Date() };
    incident.attachments.push(attachment);
    await incident.save();

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
    const { incidentId } = req.params;
    const { text } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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
    const { incidentId } = req.params;
    const { description, assignedTo, dueDate } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
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
    const { incidentId } = req.params;
    const { evidenceItem, interviewItem, lessonsLearned, rootCauseCategory } = req.body;

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    const incident = await TravelIncidentManagementModel.findOne({ _id: incidentId, tenantId, isSoftDeleted: false });
    if (!incident) {
      return sendError(res, 404, "Incident case not found.", requestId);
    }

    if (!incident.investigation) {
      incident.investigation = { evidence: [], interviews: [], witnesses: [], correctiveActions: [], preventiveActions: [], lessonsLearned: null, rootCauseCategory: "Process" };
    }

    if (evidenceItem && evidenceItem.description) {
      incident.investigation.evidence.push({
        type: evidenceItem.type || "Document",
        description: evidenceItem.description,
        url: evidenceItem.url || null,
        gatheredBy: userId,
        gatheredAt: new Date()
      });
    }

    if (interviewItem && interviewItem.intervieweeName && interviewItem.summary) {
      incident.investigation.interviews.push({
        intervieweeName: interviewItem.intervieweeName,
        role: interviewItem.role || "Witness",
        summary: interviewItem.summary,
        interviewedBy: userId,
        interviewedAt: new Date()
      });
    }

    if (lessonsLearned) {
      incident.investigation.lessonsLearned = lessonsLearned;
    }
    if (rootCauseCategory) {
      incident.investigation.rootCauseCategory = rootCauseCategory;
    }

    incident.status = incident.status === "reported" ? "in_investigation" : incident.status;
    await incident.save();

    return sendSuccess(res, 200, "Investigation updated successfully.", incident.investigation, requestId);
  } catch (err) {
    console.error("UpdateIncidentInvestigation Error:", err);
    return sendError(res, 500, err.message || "Failed to update investigation.", requestId);
  }
};

/**
 * 15. GET /api/v1/incidents/analytics
 */
export const GetIncidentAnalytics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    const analytics = await EnterpriseIncidentEngineService.getIncidentAnalytics(tenantId);
    return sendSuccess(res, 200, "Incident analytics and AI trend insights retrieved successfully.", analytics, requestId);
  } catch (err) {
    console.error("GetIncidentAnalytics Error:", err);
    return sendError(res, 500, err.message || "Failed to fetch incident analytics.", requestId);
  }
};
