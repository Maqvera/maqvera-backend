import VisaCaseModel from "../models/VisaCaseModel.js";
import CustomerModel from "../models/CustomerModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { VISA_CASE_STATUSES, VISA_TYPES, VISA_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import VisaRequirementService from "./VisaRequirementService.js";
import EnterpriseIncidentEngineService from "./EnterpriseIncidentEngineService.js";
import EnterpriseTimelineEngineService from "./EnterpriseTimelineEngineService.js";
import VisaTypeModel from "../models/VisaTypeModel.js";
import CountryMasterModel from "../models/CountryMasterModel.js";
import mongoose from "mongoose";
import VisaWorkflowService from "./VisaWorkflowService.js";

class VisaService {
  /**
   * Auto-generates Case Number: VIS-YYYY-XXXXXX
   */
  static async generateCaseNumber(tenantId) {
    const year = new Date().getFullYear();
    const prefix = `VIS-${year}-`;
    const count = await VisaCaseModel.countDocuments({
      tenantId,
      caseNumber: new RegExp(`^${prefix}`)
    });
    const incrementalNumber = String(count + 1).padStart(6, "0");
    return `${prefix}${incrementalNumber}`;
  }

  /**
   * Dynamic Requirements Engine via VisaRequirementService Rule Engine
   */
  static async getDynamicRequirements({ destinationCountry, visaType, nationality = "ALL", age = 30, employmentStatus = "employed", tenantId }) {
    const travelerCategory = age < 18 ? "Child" : age >= 60 ? "Senior" : "Adult";
    const resolved = await VisaRequirementService.getRequirementProfilesForCountry(
      destinationCountry,
      { visaType, nationality, travelerCategory },
      tenantId
    );

    const profile = resolved.resolvedProfile;
    if (!profile) throw new Error("No active requirement profile matched this case. Configure a profile before creating the Visa Case.");
    const reqDocConfig = (profile.requiredDocuments || []).map(doc => ({
        documentType: doc.documentType,
        title: doc.title,
        isMandatory: doc.isMandatory !== undefined ? doc.isMandatory : true,
        status: "pending",
        fileUrl: null,
        objectStorageKey: null,
        verificationStatus: "unverified"
      }));

    return reqDocConfig;
  }

  /**
   * Work Queue & Assignment Engine
   * Assigns case to Work Queue or Officer based on country team, priority, workload.
   */
  static evaluateAssignment({ destinationCountry, priority, assignedTo = null, branchId }) {
    if (assignedTo) {
      return {
        assignedTo,
        queueType: "manual_assigned",
        assignedConsultantName: null
      };
    }

    let queueType = "workload_queue";

    if (priority === "high" || priority === "vip") {
      queueType = "priority_queue";
    }

    return {
      assignedTo: null,
      queueType,
      assignedConsultantName: `Unassigned (${queueType})`
    };
  }

  static async resolveCountry({ countryId, destinationCountry }, tenantId) {
    if (!countryId && !destinationCountry) throw new Error("countryId or destinationCountry is required.");
    if (mongoose.connection.readyState !== 1) return { countryId: countryId || null, name: destinationCountry || countryId };
    const country = await CountryMasterModel.findOne({
      tenantId,
      isActive: true,
      $or: [{ countryId }, { code: String(countryId || destinationCountry || "").toUpperCase() }, { name: new RegExp(`^${destinationCountry || ""}$`, "i") }]
    });
    if (!country) throw new Error("Country not found or inactive for this tenant.");
    return { countryId: country.countryId, name: country.name };
  }

  static async resolveVisaType({ visaTypeId, visaType }, tenantId) {
    if (!visaTypeId && !visaType) throw new Error("visaTypeId or visaType is required.");
    if (mongoose.connection.readyState !== 1) return { visaTypeId: visaTypeId || null, code: visaType || visaTypeId };
    const typeFilter = { tenantId, isActive: true, $or: [{ code: visaType || visaTypeId }, { name: new RegExp(`^${visaType || ""}$`, "i") }] };
    if (visaTypeId && mongoose.Types.ObjectId.isValid(visaTypeId)) typeFilter.$or.push({ _id: visaTypeId });
    const visaTypeRecord = await VisaTypeModel.findOne(typeFilter);
    if (!visaTypeRecord) throw new Error("Visa type not found or inactive for this tenant.");
    return { visaTypeId: visaTypeRecord._id.toString(), code: visaTypeRecord.code };
  }

  /**
   * Create Visa Case
   */
  static async createVisaCase({ travelerId, countryId, destinationCountry, visaTypeId, visaType, travelPurpose, plannedTravelDate, priority = "normal", assignedTo = null, notes }, tenantId, branchId, userId) {
    if (!travelerId) {
      throw new Error("Traveler ID (travelerId) is required.");
    }

    const country = await this.resolveCountry({ countryId, destinationCountry }, tenantId);
    const visaTypeRecord = await this.resolveVisaType({ visaTypeId, visaType }, tenantId);
    const workflowDefinition = await VisaWorkflowService.getWorkflowDefinitionForTenant(tenantId);
    const initialWorkflowState = workflowDefinition.initialState || workflowDefinition.states.find((state) => state.type === "initial")?.key;
    if (!initialWorkflowState) throw new Error("Active Visa workflow has no initial state.");
    const destCountry = country.name;
    const vType = visaTypeRecord.code;

    // 1. Validate Traveler
    const traveler = await CustomerModel.findOne({ _id: travelerId, tenantId, isSoftDeleted: { $ne: true } });
    if (!traveler || ["blacklisted", "archived", "inactive"].includes(String(traveler.status || "").toLowerCase())) {
      throw new Error(`Traveler with ID ${travelerId} not found or inactive.`);
    }

    // 2. Check Duplicate Active Case
    const activeCase = await VisaCaseModel.findOne({
      tenantId,
      travelerId,
      destinationCountry: new RegExp(`^${destCountry}$`, "i"),
      visaType: new RegExp(`^${vType}$`, "i"),
      status: { $nin: [VISA_CASE_STATUSES.TRAVEL_READY, VISA_CASE_STATUSES.REJECTED, VISA_CASE_STATUSES.CANCELLED, VISA_CASE_STATUSES.EXPIRED, VISA_CASE_STATUSES.WITHDRAWN] },
      isSoftDeleted: { $ne: true }
    });

    if (activeCase) {
      throw new Error(`An active visa case (${activeCase.caseNumber}) already exists for this traveler and destination.`);
    }

    // 3. Generate Case Number
    const caseNumber = await this.generateCaseNumber(tenantId);

    // 4. Work Queue / Assignment Engine
    const assignment = this.evaluateAssignment({ destinationCountry: destCountry, priority, assignedTo, branchId });

    // 5. Generate Dynamic Requirements
    const requirementResolution = await VisaRequirementService.getRequirementProfilesForCountry(destCountry, {
      visaType: vType, nationality: traveler.nationality || "ALL", travelerCategory: traveler.dateOfBirth && new Date().getFullYear() - new Date(traveler.dateOfBirth).getFullYear() < 18 ? "Child" : "Adult"
    }, tenantId);
    const requirementProfileSnapshot = VisaRequirementService.toCaseSnapshot(requirementResolution.resolvedProfile);
    const requiredDocuments = await this.getDynamicRequirements({
      destinationCountry: destCountry,
      countryId: country.countryId,
      visaType: vType,
      visaTypeId: visaTypeRecord.visaTypeId,
      travelPurpose: travelPurpose || null,
      plannedTravelDate: plannedTravelDate || null,
      expectedTravelDate: plannedTravelDate || null,
      nationality: traveler.nationality || "ALL",
      tenantId
    });

    // 6. Traveler Snapshot
    const primaryPassport = Array.isArray(traveler.passports) ? (traveler.passports.find(p => p.isPrimary) || traveler.passports[0] || {}) : {};
    const travelerSnapshot = {
      title: traveler.title,
      firstName: traveler.firstName,
      lastName: traveler.lastName,
      fullName: `${traveler.firstName || ""} ${traveler.lastName || ""}`.trim(),
      passportNumber: primaryPassport.passportNumber || traveler.nationalId || null,
      passportExpiry: primaryPassport.expiryDate || null,
      passportIssueCountry: primaryPassport.countryOfIssue || traveler.nationality || null,
      gender: traveler.gender,
      dateOfBirth: traveler.dateOfBirth,
      nationality: traveler.nationality,
      phone: traveler.phone,
      email: traveler.email
    };

    // 7. Initial Visa Application
    const initialApplication = {
      applicationNumber: `${caseNumber}-APP-1`,
      visaType: vType,
      status: "draft",
      feeAmount: 0,
      notes: notes || travelPurpose || "Initial Application",
      createdBy: userId || "system",
      createdAt: new Date()
    };

    // 8. Create Visa Case Record
    const newVisaCase = new VisaCaseModel({
      tenantId,
      branchId: branchId || traveler.branchId || "main",
      caseNumber,
      travelerId,
      travelerSnapshot,
      destinationCountry: destCountry,
      countryId: country.countryId,
      visaType: vType,
      visaTypeId: visaTypeRecord.visaTypeId,
      travelPurpose: travelPurpose || null,
      plannedTravelDate: plannedTravelDate || null,
      expectedTravelDate: plannedTravelDate || null,
      status: initialWorkflowState,
      priority: (priority || "normal").toLowerCase(),
      assignedTo: assignment.assignedTo,
      workQueue: assignment.queueType,
      assignedConsultantName: assignment.assignedConsultantName,
      applications: [initialApplication],
      requiredDocuments,
      requirementProfileSnapshot,
      workflow: {
        currentStep: initialWorkflowState,
        completedSteps: [],
        totalSteps: workflowDefinition.states.length,
        isBlocked: false
      },
      timeline: [
        {
          event: VISA_DOMAIN_EVENTS.VISA_CASE_CREATED,
          description: `Visa Case ${caseNumber} created for ${destCountry} (${vType}).`,
          statusFrom: null,
          statusTo: initialWorkflowState,
          performedBy: userId || "system",
          timestamp: new Date()
        },
        {
          event: VISA_DOMAIN_EVENTS.VISA_APPLICATION_CREATED,
          description: `Initial application ${caseNumber}-APP-1 initialized.`,
          performedBy: userId || "system",
          timestamp: new Date()
        }
      ]
    });

    if (notes) {
      newVisaCase.notes.push({
        noteText: notes,
        isInternal: true,
        createdBy: userId || "system",
        createdAt: new Date()
      });
    }

    await newVisaCase.save();

    // 9. Audit Logging
    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "CREATE_VISA_CASE",
      resource: "VisaCase",
      resourceId: newVisaCase._id.toString(),
      details: { caseNumber, destinationCountry: destCountry, visaType: vType, travelerId }
    }).catch(err => console.error("AuditLog error:", err));

    // 10. Publish Domain Events
    publishEvent(VISA_DOMAIN_EVENTS.VISA_CASE_CREATED, {
      visaCaseId: newVisaCase._id,
      caseNumber,
      tenantId,
      travelerId
    });
    publishEvent(VISA_DOMAIN_EVENTS.VISA_APPLICATION_CREATED, {
      visaCaseId: newVisaCase._id,
      applicationNumber: `${caseNumber}-APP-1`,
      tenantId
    });
    publishEvent("VisaApplicationInitialized", {
      visaCaseId: newVisaCase._id,
      applicationNumber: `${caseNumber}-APP-1`,
      tenantId,
      branchId: newVisaCase.branchId
    });
    publishEvent("RequirementsGenerated", { visaCaseId: newVisaCase._id, tenantId, branchId: newVisaCase.branchId });

    return newVisaCase;
  }

  /**
   * Get Visa Cases with pagination, filtering & multi-tenancy
   */
  static async getVisaCases(query, tenantId, branchId) {
    const {
      page = 1,
      pageSize = 20,
      status,
      countryId,
      destinationCountry,
      visaTypeId,
      visaType,
      filterBranchId,
      travelerId,
      assignedTo,
      createdFrom,
      createdTo,
      search
    } = query;

    const limit = Math.min(Math.max(parseInt(pageSize, 10), 1), 100);
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * limit;

    const filter = {
      tenantId,
      isSoftDeleted: { $ne: true }
    };

    if (branchId || filterBranchId || query.branchId) {
      filter.branchId = filterBranchId || query.branchId || branchId;
    }

    if (status) filter.status = status;
    if (countryId) filter.countryId = countryId;
    if (destinationCountry) filter.destinationCountry = new RegExp(`^${destinationCountry}$`, "i");
    if (visaTypeId) filter.visaTypeId = visaTypeId;
    if (visaType) filter.visaType = new RegExp(`^${visaType}$`, "i");
    if (travelerId) filter.travelerId = travelerId;
    if (assignedTo) filter.assignedTo = assignedTo;

    if (createdFrom || createdTo) {
      filter.createdAt = {};
      if (createdFrom) filter.createdAt.$gte = new Date(createdFrom);
      if (createdTo) filter.createdAt.$lte = new Date(createdTo);
    }

    if (search) {
      filter.$or = [
        { caseNumber: new RegExp(search, "i") },
        { "travelerSnapshot.fullName": new RegExp(search, "i") },
        { "travelerSnapshot.passportNumber": new RegExp(search, "i") },
        { destinationCountry: new RegExp(search, "i") }
      ];
    }

    const [items, total] = await Promise.all([
      VisaCaseModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VisaCaseModel.countDocuments(filter)
    ]);

    return {
      items,
      pagination: {
        total,
        page: parseInt(page, 10),
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get single Visa Case by ID
   */
  static async getVisaCaseById(visaCaseId, tenantId, branchId) {
    const filter = { _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } };
    if (branchId) filter.branchId = branchId;

    const visaCase = await VisaCaseModel.findOne(filter);
    if (!visaCase) {
      throw new Error("Visa Case not found.");
    }
    return visaCase;
  }

  /**
   * Update Visa Case
   */
  static async updateVisaCase(visaCaseId, updateData, tenantId, branchId, userId) {
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);

    // Lock completed cases
    const isCompleted = [VISA_CASE_STATUSES.TRAVEL_READY, VISA_CASE_STATUSES.VISA_PRINTED].includes(visaCase.status);
    if (isCompleted && updateData.status !== VISA_CASE_STATUSES.TRAVEL_READY) {
      throw new Error("Completed visa cases are locked and cannot be edited.");
    }

    const timelineEvents = [];

    if (updateData.status && updateData.status !== visaCase.status) {
      throw new Error("Status changes must use the workflow transition endpoint.");
    }

    if (updateData.priority && updateData.priority !== visaCase.priority) {
      timelineEvents.push({
        event: "VisaPriorityChanged",
        description: `Priority updated from ${visaCase.priority} to ${updateData.priority}.`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      visaCase.priority = updateData.priority;
    }

    if (updateData.assignedTo && updateData.assignedTo !== visaCase.assignedTo) {
      timelineEvents.push({
        event: "VisaOfficerAssigned",
        description: `Case assigned to officer ${updateData.assignedTo}.`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      visaCase.assignedTo = updateData.assignedTo;
      if (updateData.assignedConsultantName) {
        visaCase.assignedConsultantName = updateData.assignedConsultantName;
      }
    }

    if (updateData.expectedTravelDate !== undefined) visaCase.expectedTravelDate = updateData.expectedTravelDate;
    if (updateData.plannedTravelDate !== undefined) visaCase.plannedTravelDate = updateData.plannedTravelDate;
    if (Array.isArray(updateData.tags)) visaCase.tags = updateData.tags;

    if (updateData.notes) {
      visaCase.notes.push({
        noteText: typeof updateData.notes === "string" ? updateData.notes : JSON.stringify(updateData.notes),
        isInternal: true,
        createdBy: userId || "system",
        createdAt: new Date()
      });
    }

    if (timelineEvents.length > 0) {
      visaCase.timeline.push(...timelineEvents);
    }

    visaCase.version = (visaCase.version || 1) + 1;
    await visaCase.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "UPDATE_VISA_CASE",
      resource: "VisaCase",
      resourceId: visaCase._id.toString(),
      details: updateData
    }).catch(err => console.error("AuditLog error:", err));

    publishEvent("VisaCaseUpdated", { visaCaseId, tenantId, updatedBy: userId });

    return visaCase;
  }

  /**
   * Soft Delete / Archive Visa Case
   */
  static async deleteVisaCase(visaCaseId, tenantId, branchId, userId) {
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);

    if ([VISA_CASE_STATUSES.TRAVEL_READY, VISA_CASE_STATUSES.VISA_PRINTED].includes(visaCase.status)) {
      throw new Error("Completed visa cases cannot be deleted.");
    }

    visaCase.isSoftDeleted = true;
    visaCase.deletedAt = new Date();
    visaCase.timeline.push({
      event: "VisaCaseArchived",
      description: `Visa Case archived by user ${userId || "system"}.`,
      performedBy: userId || "system",
      timestamp: new Date()
    });

    await visaCase.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "DELETE_VISA_CASE",
      resource: "VisaCase",
      resourceId: visaCase._id.toString(),
      details: { caseNumber: visaCase.caseNumber, archivedAt: visaCase.deletedAt }
    }).catch(err => console.error("AuditLog error:", err));

    publishEvent("VisaCaseArchived", { visaCaseId, caseNumber: visaCase.caseNumber, tenantId });

    return { message: `Visa Case ${visaCase.caseNumber} archived successfully.` };
  }

  /**
   * Adds an incident to a Visa Case via EnterpriseIncidentEngineService
   */
  static async addVisaCaseIncident(visaCaseId, incidentData, tenantId, branchId, userId) {
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId).catch(() => null);

    const createdIncident = await EnterpriseIncidentEngineService.createIncident(
      {
        visaCaseId,
        visaCase,
        ...incidentData
      },
      tenantId,
      branchId,
      userId
    );

    // Return format compatible with legacy and new enterprise expectations
    const incObj = createdIncident.toObject ? createdIncident.toObject() : createdIncident;
    return {
      ...incObj,
      incidentId: incObj._id ? incObj._id.toString() : (incObj.incidentId || incObj.incidentNumber)
    };
  }

  /**
   * Returns incidents for a Visa Case
   */
  static async getVisaCaseIncidents(visaCaseId, tenantId, branchId) {
    const result = await EnterpriseIncidentEngineService.getIncidents({ visaCaseId }, tenantId);
    if (result && Array.isArray(result.items) && result.items.length > 0) {
      return result.items;
    }
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);
    return Array.isArray(visaCase.incidents) ? visaCase.incidents : [];
  }

  /**
   * Returns complete activity timeline for a Visa Case
   */
  static async getVisaCaseTimeline(visaCaseId, query, tenantId, branchId) {
    await this.getVisaCaseById(visaCaseId, tenantId, branchId);
    return EnterpriseTimelineEngineService.getTimeline({ visaCaseId, branchId, ...query }, tenantId);
  }

  /**
   * Adds a manual operational note to a Visa Case
   */
  static async addVisaCaseNote(visaCaseId, noteData, tenantId, branchId, userId, requestContext = {}) {
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);
    const note = await EnterpriseTimelineEngineService.recordManualNote({
      visaCaseId,
      visaCase,
      noteType: noteData.noteType || noteData.type || "Internal",
      text: noteData.text || noteData.noteText || noteData.content || "",
      visibility: noteData.visibility || "Internal",
      mentions: noteData.mentions || [],
      attachments: noteData.attachments || [],
      isPrivate: noteData.isPrivate || false,
      tenantId,
      branchId,
      userId,
      requestContext
    });

    return note;
  }

  /**
   * Builds AI Context summary for a Visa Case
   */
  static async getVisaCaseAIContext(visaCaseId, tenantId, branchId) {
    await this.getVisaCaseById(visaCaseId, tenantId, branchId);
    return await EnterpriseTimelineEngineService.buildAIContext(visaCaseId, tenantId);
  }
}

export default VisaService;
