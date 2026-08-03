import mongoose from "mongoose";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import UnifiedActivityStreamModel from "../models/UnifiedActivityStreamModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import IncidentPolicyModel from "../models/IncidentPolicyModel.js";
import { v4 as uuidv4 } from "uuid";

class EnterpriseIncidentEngineService {
  /**
   * Calculates SLA due dates based on Severity Level
   */
  static calculateSLA(severity) {
    const now = new Date();
    const slaConfig = {
      Emergency: { firstResponseMins: 15, resolutionHours: 1 },
      Critical: { firstResponseMins: 30, resolutionHours: 2 },
      High: { firstResponseMins: 60, resolutionHours: 6 },
      Medium: { firstResponseMins: 240, resolutionHours: 24 },
      Low: { firstResponseMins: 720, resolutionHours: 48 }
    };

    const cfg = slaConfig[severity] || slaConfig.Medium;
    const firstResponseDueDate = new Date(now.getTime() + cfg.firstResponseMins * 60 * 1000);
    const resolutionDueDate = new Date(now.getTime() + cfg.resolutionHours * 60 * 60 * 1000);

    return {
      firstResponseDueDate,
      resolutionDueDate,
      slaDueDate: resolutionDueDate,
      isViolated: false,
      firstResponseBreached: false,
      resolutionBreached: false
    };
  }

  static async getPolicy(tenantId) {
    if (mongoose.connection?.readyState !== 1) return null;
    const policy = await IncidentPolicyModel.findOne({ tenantId, isActive: true }).lean();
    if (!policy) throw new Error("No active incident policy is configured for this tenant.");
    return policy;
  }

  static async resolveSLA(severity, tenantId) {
    const policy = await this.getPolicy(tenantId);
    if (!policy) return this.calculateSLA(severity);
    const configuredSeverity = policy.severities.find((item) => item.name === severity && item.isActive);
    if (!configuredSeverity) throw new Error("Incident severity is not active in the tenant incident policy.");
    const now = new Date();
    const firstResponseDueDate = new Date(now.getTime() + configuredSeverity.firstResponseMins * 60 * 1000);
    const resolutionDueDate = new Date(now.getTime() + configuredSeverity.resolutionHours * 60 * 60 * 1000);
    return { firstResponseDueDate, resolutionDueDate, slaDueDate: resolutionDueDate, isViolated: false, firstResponseBreached: false, resolutionBreached: false, locksVisaCase: configuredSeverity.locksVisaCase };
  }

  /**
   * Auto-generates unique Incident Number: INC-YYYY-XXXXXX
   */
  static async generateIncidentNumber(tenantId) {
    const year = new Date().getFullYear();
    let count = 0;
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      count = await TravelIncidentManagementModel.countDocuments({ tenantId }).catch(() => 0);
    } else {
      return `${process.env.INCIDENT_NUMBER_PREFIX || "INC"}-${year}-${uuidv4().slice(0, 8).toUpperCase()}`;
    }
    return `INC-${year}-${String(count + 1).padStart(6, "0")}`;
  }

  /**
   * Helper to record Timeline & Activity Stream entries
   */
  static async recordTimeline({ tenantId, visaCaseId, travelPlanId, eventType, title, description, performedBy = null, metadata = {} }) {
    try {
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        if (travelPlanId) {
          await TravelTimelineModel.create({
            travelPlanId,
            tenantId,
            module: "IncidentManagement",
            eventType,
            title,
            description,
            performedBy,
            performedByName: "Staff",
            metadata
          }).catch(err => console.error("TravelTimeline error:", err));
        }

        await UnifiedActivityStreamModel.create({
          tenantId,
          module: "IncidentManagement",
          referenceId: visaCaseId || travelPlanId || null,
          eventType,
          title,
          description,
          severity: metadata.severity === "Emergency" || metadata.severity === "Critical" ? "Critical" : "Info",
          performedBy,
          metadata
        }).catch(err => console.error("UnifiedActivityStream error:", err));
      }

      if (visaCaseId) {
        let visaCase = metadata.visaCase;
        if (!visaCase && mongoose.connection && mongoose.connection.readyState === 1) {
          visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId }).catch(() => null);
        }
        if (visaCase) {
          visaCase.timeline = Array.isArray(visaCase.timeline) ? visaCase.timeline : [];
          visaCase.timeline.push({
            event: eventType,
            description: `${title}: ${description}`,
            performedBy: performedBy || "system",
            timestamp: new Date()
          });
          if (typeof visaCase.save === "function") {
            await visaCase.save();
          }
        }
      }
    } catch (err) {
      console.error("EnterpriseIncidentEngineService.recordTimeline error:", err);
    }
  }

  /**
   * 1. CREATE INCIDENT
   */
  static async createIncident(incidentData, tenantId, branchId, userId) {
    const {
      visaCaseId,
      travelPlanId,
      sourceModule = "Visa",
      category = "Operational Exception",
      severity = "Medium",
      title,
      description,
      location,
      affectedTravelerIds,
      assignedTo,
      assignedToName,
      assignedTeam = null
    } = incidentData;

    if (!title || !description) {
      throw new Error("Title and description are required for incident creation.");
    }

    let resolvedBranchId = branchId || "main";
    let visaCase = incidentData.visaCase || null;
    let travelPlan = null;

    if (visaCaseId && !visaCase && mongoose.connection && mongoose.connection.readyState === 1) {
      visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } }).catch(() => null);
    }
    if (visaCase) {
      resolvedBranchId = visaCase.branchId || resolvedBranchId;
    }

    if (travelPlanId && mongoose.connection && mongoose.connection.readyState === 1) {
      travelPlan = await TravelPlanModel.findOne({ _id: travelPlanId, tenantId, isSoftDeleted: { $ne: true } }).catch(() => null);
      if (travelPlan) {
        resolvedBranchId = travelPlan.branchId || resolvedBranchId;
      }
    }

    const incidentNumber = await this.generateIncidentNumber(tenantId);
    const policy = await this.getPolicy(tenantId);
    const categoryConfig = policy?.categories.find((item) => item.name === category && item.isActive);
    if (policy && !categoryConfig) throw new Error("Incident category is not active in the tenant incident policy.");
    const slaStatus = await this.resolveSLA(severity, tenantId);

    const newIncident = new TravelIncidentManagementModel({
      tenantId,
      branchId: resolvedBranchId,
      incidentNumber,
      visaCaseId: visaCase ? visaCase._id : (visaCaseId || null),
      visaCaseNumber: visaCase ? visaCase.caseNumber : null,
      travelPlanId: travelPlan ? travelPlan._id : (travelPlanId || null),
      sourceModule,
      category,
      severity,
      status: assignedTo ? "assigned" : "reported",
      title,
      description,
      assignedTo: assignedTo || null,
      assignedToName: assignedToName || null,
      assignedTeam: assignedTeam || policy?.defaultAssignmentTeam || "Operations",
      reportedBy: userId || "system",
      reportedByName: "Staff",
      location: location || { name: null, latitude: null, longitude: null },
      affectedTravelerIds: Array.isArray(affectedTravelerIds) ? affectedTravelerIds : (visaCase ? [visaCase.travelerId] : []),
      slaStatus,
      investigation: {
        evidence: [],
        interviews: [],
        witnesses: [],
        correctiveActions: [],
        preventiveActions: [],
        lessonsLearned: null,
        rootCauseCategory: "Process"
      }
    });

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      await newIncident.save();
    }

    const locksVisaCase = policy ? Boolean(slaStatus.locksVisaCase || categoryConfig?.locksVisaCase) : ["Critical", "Emergency"].includes(severity);
    if (visaCase && locksVisaCase) {
      visaCase.isLocked = true;
      visaCase.lockReason = `Case auto-locked due to ${severity} incident (${incidentNumber}): ${title}`;
      if (!visaCase.workflow) visaCase.workflow = {};
      visaCase.workflow.isBlocked = true;
      visaCase.workflow.blockReason = visaCase.lockReason;
      
      visaCase.incidents = Array.isArray(visaCase.incidents) ? visaCase.incidents : [];
      visaCase.incidents.push({
        title,
        description,
        severity: severity.toLowerCase(),
        status: "open",
        reportedAt: new Date(),
        reportedBy: userId || "system"
      });

      if (typeof visaCase.save === "function") {
        await visaCase.save();
      }
    } else if (visaCase) {
      visaCase.incidents = Array.isArray(visaCase.incidents) ? visaCase.incidents : [];
      visaCase.incidents.push({
        title,
        description,
        severity: severity.toLowerCase(),
        status: "open",
        reportedAt: new Date(),
        reportedBy: userId || "system"
      });
      if (typeof visaCase.save === "function") {
        await visaCase.save();
      }
    }

    // Record Timeline & Audit
    await this.recordTimeline({
      tenantId,
      visaCaseId: visaCase ? visaCase._id : null,
      travelPlanId: travelPlan ? travelPlan._id : null,
      eventType: "IncidentReported",
      title: `Incident Reported (${incidentNumber})`,
      description: `[${severity}] ${title}`,
      performedBy: userId,
      metadata: { incidentId: newIncident._id, incidentNumber, severity, category, visaCase }
    });

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      await AuditLogModel.create({
        tenantId,
        userId: userId || "system",
        action: "CREATE_INCIDENT",
        module: "IncidentManagement",
        targetId: newIncident._id.toString(),
        details: { incidentNumber, category, severity, visaCaseId: visaCase ? visaCase._id : null }
      }).catch(err => console.error("AuditLog error:", err));
    }

    // Publish Domain Events
    publishEvent("IncidentCreated", {
      incidentId: newIncident._id,
      incidentNumber,
      visaCaseId: visaCase ? visaCase._id : null,
      travelPlanId: travelPlan ? travelPlan._id : null,
      severity,
      category,
      tenantId
    });

    publishEvent("IncidentReported", {
      incidentId: newIncident._id,
      incidentNumber,
      visaCaseId: visaCase ? visaCase._id : null,
      severity,
      category,
      tenantId
    });

    if (severity === "Emergency") {
      publishEvent("EmergencyIncidentReported", {
        incidentId: newIncident._id,
        incidentNumber,
        visaCaseId: visaCase ? visaCase._id : null,
        tenantId
      });
    }

    return newIncident;
  }

  /**
   * 2. LIST INCIDENTS
   */
  static async getIncidents(query, tenantId) {
    const page = Math.max(parseInt(query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize || "20", 10), 1), 100);

    let items = [];
    let totalItems = 0;

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const filter = { tenantId, isSoftDeleted: false };

      if (query.visaCaseId) filter.visaCaseId = query.visaCaseId;
      if (query.travelPlanId) filter.travelPlanId = query.travelPlanId;
      if (query.category) filter.category = query.category;
      if (query.severity) filter.severity = query.severity;
      if (query.status) filter.status = query.status.toLowerCase();
      if (query.assignedTo) filter.assignedTo = query.assignedTo;
      if (query.reportedBy) filter.reportedBy = query.reportedBy;

      if (query.dateFrom || query.dateTo) {
        filter.createdAt = {};
        if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
        if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
      }

      const sortField = query.sort || "createdAt";
      const sortOrder = query.order === "asc" ? 1 : -1;

      const [fetchedItems, count] = await Promise.all([
        TravelIncidentManagementModel.find(filter)
          .sort({ [sortField]: sortOrder })
          .skip((page - 1) * pageSize)
          .limit(pageSize),
        TravelIncidentManagementModel.countDocuments(filter)
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
   * 3. GET INCIDENT BY ID
   */
  static async getIncidentById(incidentId, tenantId) {
    const incident = await TravelIncidentManagementModel.findOne({
      _id: incidentId,
      tenantId,
      isSoftDeleted: false
    });

    if (!incident) {
      throw new Error("Incident case not found.");
    }
    return incident;
  }

  /**
   * 4. UPDATE INCIDENT
   */
  static async updateIncident(incidentId, updateData, tenantId, userId) {
    const incident = await this.getIncidentById(incidentId, tenantId);

    if (incident.status === "closed" && updateData.status !== "reopened") {
      throw new Error("Closed incidents require an explicit reopen request.");
    }

    const editableFields = [
      "severity",
      "priority",
      "assignedTo",
      "assignedToName",
      "assignedTeam",
      "status",
      "title",
      "description",
      "category",
      "location"
    ];

    let escalated = false;
    let reopened = false;
    const changes = {};

    editableFields.forEach((field) => {
      if (updateData[field] !== undefined) {
        if (field === "severity" && updateData.severity === "Critical" && incident.severity !== "Critical") {
          escalated = true;
        }
        if (field === "status" && updateData.status === "reopened") {
          reopened = true;
        }
        changes[field] = updateData[field];
      }
    });

    if (Object.keys(changes).length === 0) {
      throw new Error("No valid fields provided for update.");
    }

    Object.assign(incident, changes);

    if (changes.severity) {
      const newSLA = await this.resolveSLA(changes.severity, tenantId);
      incident.slaStatus.slaDueDate = newSLA.slaDueDate;
      incident.slaStatus.resolutionDueDate = newSLA.resolutionDueDate;
    }

    await incident.save();

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "IncidentUpdated",
      title: `Incident ${incident.incidentNumber} Updated`,
      description: `Updated fields: ${Object.keys(changes).join(", ")}`,
      performedBy: userId,
      metadata: changes
    });
    if (mongoose.connection?.readyState === 1) await AuditLogModel.create({ tenantId, branchId: incident.branchId, userId: userId || "system", action: "UPDATE_INCIDENT", resource: "Incident", resourceId: incident._id.toString(), details: changes }).catch(() => null);

    if (escalated) {
      publishEvent("IncidentEscalated", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });
    }
    if (reopened) {
      publishEvent("IncidentReopened", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });
    }
    publishEvent("IncidentUpdated", { incidentId: incident._id, tenantId });

    return incident;
  }

  /**
   * 5. ASSIGN INCIDENT
   */
  static async assignIncident(incidentId, { assigneeId, assigneeName, team = "Operations" }, tenantId, userId) {
    if (!assigneeId) {
      throw new Error("userId / assigneeId is required for assignment.");
    }

    const incident = await this.getIncidentById(incidentId, tenantId);

    incident.assignedTo = assigneeId;
    incident.assignedToName = assigneeName || assigneeId;
    incident.assignedTeam = team;
    if (incident.status === "reported") {
      incident.status = "assigned";
    }

    // Mark first response SLA completed if not set
    if (!incident.slaStatus.firstResponseCompletedAt) {
      incident.slaStatus.firstResponseCompletedAt = new Date();
      if (incident.slaStatus.firstResponseDueDate && incident.slaStatus.firstResponseCompletedAt > incident.slaStatus.firstResponseDueDate) {
        incident.slaStatus.firstResponseBreached = true;
      }
    }

    await incident.save();

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "IncidentAssigned",
      title: "Incident Assigned",
      description: `Incident ${incident.incidentNumber} assigned to ${incident.assignedToName} (${team})`,
      performedBy: userId
    });
    if (mongoose.connection?.readyState === 1) await AuditLogModel.create({ tenantId, branchId: incident.branchId, userId: userId || "system", action: "RESOLVE_INCIDENT", resource: "Incident", resourceId: incident._id.toString(), details: { resolutionSummary, rootCause, correctiveAction, preventiveAction } }).catch(() => null);

    publishEvent("IncidentAssigned", { incidentId: incident._id, assigneeId, team, tenantId });

    return incident;
  }

  /**
   * 6. ADD EVIDENCE / INVESTIGATION ITEM
   */
  static async addEvidence(incidentId, evidenceData, tenantId, userId) {
    const incident = await this.getIncidentById(incidentId, tenantId);

    if (!evidenceData.description) {
      throw new Error("Evidence description is required.");
    }

    if (!incident.investigation) {
      incident.investigation = { evidence: [], interviews: [], witnesses: [], correctiveActions: [], preventiveActions: [] };
    }

    const item = {
      type: evidenceData.type || "Document",
      description: evidenceData.description,
      url: evidenceData.url || null,
      gatheredBy: userId || "system",
      gatheredAt: new Date()
    };

    incident.investigation.evidence.push(item);

    if (["reported", "assigned"].includes(incident.status)) {
      incident.status = "in_investigation";
    }

    await incident.save();

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "InvestigationStarted",
      title: `Evidence Attached (${incident.incidentNumber})`,
      description: item.description,
      performedBy: userId
    });

    publishEvent("InvestigationStarted", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });

    return item;
  }

  /**
   * 7. RESOLVE INCIDENT
   */
  static async resolveIncident(incidentId, { resolutionSummary, rootCause, correctiveAction, preventiveAction }, tenantId, userId) {
    if (!resolutionSummary) {
      throw new Error("resolutionSummary is required to resolve incident.");
    }

    const incident = await this.getIncidentById(incidentId, tenantId);

    if (["High", "Critical", "Emergency"].includes(incident.severity) && !rootCause) {
      throw new Error(`rootCause is required for resolving '${incident.severity}' severity incidents.`);
    }

    const now = new Date();
    incident.status = "resolved";
    incident.resolution = {
      resolutionSummary,
      rootCause: rootCause || null,
      correctiveAction: correctiveAction || null,
      preventiveAction: preventiveAction || null,
      resolvedAt: now,
      resolvedBy: userId || "Staff"
    };

    // Calculate SLA completion
    incident.slaStatus.resolutionCompletedAt = now;
    if (incident.slaStatus.resolutionDueDate && now > incident.slaStatus.resolutionDueDate) {
      incident.slaStatus.resolutionBreached = true;
      incident.slaStatus.isViolated = true;
    }

    await incident.save();

    // Check if associated Visa Case should be unlocked
    if (incident.visaCaseId) {
      const remainingActiveIncidents = await TravelIncidentManagementModel.countDocuments({
        tenantId,
        visaCaseId: incident.visaCaseId,
        severity: { $in: ["Critical", "Emergency"] },
        status: { $nin: ["resolved", "verified", "closed", "rejected"] },
        _id: { $ne: incident._id }
      });

      if (remainingActiveIncidents === 0) {
        const visaCase = await VisaCaseModel.findOne({ _id: incident.visaCaseId, tenantId });
        if (visaCase) {
          visaCase.isLocked = false;
          visaCase.lockReason = null;
          if (visaCase.workflow) {
            visaCase.workflow.isBlocked = false;
            visaCase.workflow.blockReason = null;
          }
          await visaCase.save();
        }
      }
    }

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "IncidentResolved",
      title: `Incident Resolved (${incident.incidentNumber})`,
      description: resolutionSummary,
      performedBy: userId
    });

    publishEvent("IncidentResolved", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });

    return incident;
  }

  /**
   * 8. VERIFY INCIDENT RESOLUTION
   */
  static async verifyIncident(incidentId, tenantId, userId) {
    const incident = await this.getIncidentById(incidentId, tenantId);

    if (incident.status !== "resolved") {
      throw new Error("Only resolved incidents can be verified.");
    }

    incident.status = "verified";
    if (!incident.resolution) incident.resolution = {};
    incident.resolution.verifiedAt = new Date();
    incident.resolution.verifiedBy = userId || "Staff";

    await incident.save();

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "IncidentVerified",
      title: `Incident Verified (${incident.incidentNumber})`,
      description: `Resolution verified by ${userId}`,
      performedBy: userId
    });

    publishEvent("IncidentVerified", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });

    return incident;
  }

  /**
   * 9. CLOSE INCIDENT
   */
  static async closeIncident(incidentId, tenantId, userId) {
    const incident = await this.getIncidentById(incidentId, tenantId);

    incident.status = "closed";
    if (!incident.resolution) incident.resolution = {};
    incident.resolution.closedAt = new Date();
    incident.resolution.closedBy = userId || "Staff";

    await incident.save();

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "IncidentClosed",
      title: `Incident Closed (${incident.incidentNumber})`,
      description: `Incident officially closed.`,
      performedBy: userId
    });

    publishEvent("IncidentClosed", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });

    return incident;
  }

  /**
   * 10. REOPEN INCIDENT
   */
  static async reopenIncident(incidentId, reason, tenantId, userId) {
    const incident = await this.getIncidentById(incidentId, tenantId);

    incident.status = "reopened";
    incident.comments = Array.isArray(incident.comments) ? incident.comments : [];
    incident.comments.push({
      authorId: userId,
      authorName: "Staff",
      text: `Incident reopened: ${reason || "No reason provided"}`,
      createdAt: new Date()
    });

    await incident.save();

    await this.recordTimeline({
      tenantId,
      visaCaseId: incident.visaCaseId,
      travelPlanId: incident.travelPlanId,
      eventType: "IncidentReopened",
      title: `Incident Reopened (${incident.incidentNumber})`,
      description: reason || "Reopened for re-investigation",
      performedBy: userId
    });

    publishEvent("IncidentReopened", { incidentId: incident._id, incidentNumber: incident.incidentNumber, tenantId });

    return incident;
  }

  /**
   * 11. GET INCIDENT ANALYTICS
   */
  static async getIncidentAnalytics(tenantId) {
    let incidents = [];
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      incidents = await TravelIncidentManagementModel.find({ tenantId, isSoftDeleted: false });
    }

    const totalIncidents = incidents.length;
    const severityBreakdown = { Emergency: 0, Critical: 0, High: 0, Medium: 0, Low: 0 };
    const categoryBreakdown = {};
    const statusBreakdown = {};
    let slaViolations = 0;

    incidents.forEach((inc) => {
      if (severityBreakdown[inc.severity] !== undefined) severityBreakdown[inc.severity]++;
      categoryBreakdown[inc.category] = (categoryBreakdown[inc.category] || 0) + 1;
      statusBreakdown[inc.status] = (statusBreakdown[inc.status] || 0) + 1;

      if (inc.slaStatus?.isViolated || (inc.slaStatus?.slaDueDate && new Date(inc.slaStatus.slaDueDate) < new Date() && !["resolved", "verified", "closed"].includes(inc.status))) {
        slaViolations++;
      }
    });

    const sortedCategories = Object.entries(categoryBreakdown).sort((a, b) => b[1] - a[1]);
    const topRecurringCategory = sortedCategories.length > 0 ? sortedCategories[0][0] : "None";

    return {
      totalIncidents,
      openIncidents: totalIncidents - ((statusBreakdown.resolved || 0) + (statusBreakdown.verified || 0) + (statusBreakdown.closed || 0)),
      resolvedIncidents: (statusBreakdown.resolved || 0) + (statusBreakdown.verified || 0) + (statusBreakdown.closed || 0),
      severityBreakdown,
      categoryBreakdown,
      statusBreakdown,
      slaComplianceRate: totalIncidents > 0 ? (((totalIncidents - slaViolations) / totalIncidents) * 100).toFixed(1) + "%" : "100%",
      aiTrendInsights: {
        topRecurringCategory,
        recommendation: totalIncidents > 0 ? `High frequency of ${topRecurringCategory} incidents detected. Consider reviewing process automation and vendor SLAs.` : "Operational incident rates are within optimal threshold."
      }
    };
  }
}

export default EnterpriseIncidentEngineService;
