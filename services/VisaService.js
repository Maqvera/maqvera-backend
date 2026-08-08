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
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import mongoose from "mongoose";
import VisaWorkflowService from "./VisaWorkflowService.js";

class VisaService {
  /**
   * Auto-generates Case Number: VIS-YYYY-XXXXXX
   */
  static async generateCaseNumber(tenantId) {
    const year = new Date().getFullYear();
    // "Case Number Format ... configurable" — was hardcoded to "VIS-",
    // unlike Incident numbers which already follow this exact env-var
    // pattern (INCIDENT_NUMBER_PREFIX).
    const prefix = `${process.env.VISA_CASE_NUMBER_PREFIX || "VIS"}-${year}-`;
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
        verificationStatus: "unverified",
        requiredPages: doc.requiredPages ?? null,
        requiresSignature: doc.requiresSignature || false,
        requiresStamp: doc.requiresStamp || false
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

    // Country Specialist Assignment: no officer-specialization model exists
    // anywhere in this codebase yet (no field on EmployeeProfileModel or
    // elsewhere designates a "handles Country X" specialist), so this can't
    // auto-match a specific officer without fabricating that data — it does
    // group the case into a country-specific queue so it's at least
    // routable/filterable for manual specialist assignment.
    let queueType = destinationCountry ? `country_team:${destinationCountry.toLowerCase().replace(/\s+/g, "_")}` : "workload_queue";

    if (priority === "high" || priority === "vip") {
      queueType = "priority_queue";
    }

    // Branch Assignment: destinationCountry/branchId used to be accepted
    // params that the queue logic silently ignored.
    if (branchId) {
      queueType = `${queueType}:branch_${branchId}`;
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
    // getWorkflowDefinition is now genuinely tenant-aware and DB-backed
    // (WorkflowDefinitionModel, falling back to the hardcoded default when
    // nothing's been seeded yet) — see VisaWorkflowService for the fix.
    const workflowDefinition = await VisaWorkflowService.getWorkflowDefinition(null, tenantId);
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
      branchId: newVisaCase.branchId,
      travelerId
    });
    publishEvent(VISA_DOMAIN_EVENTS.VISA_APPLICATION_CREATED, {
      visaCaseId: newVisaCase._id,
      applicationNumber: `${caseNumber}-APP-1`,
      tenantId,
      branchId: newVisaCase.branchId
    });
    publishEvent("VisaApplicationInitialized", {
      visaCaseId: newVisaCase._id,
      applicationNumber: `${caseNumber}-APP-1`,
      tenantId,
      branchId: newVisaCase.branchId
    });
    publishEvent("RequirementsGenerated", { visaCaseId: newVisaCase._id, tenantId, branchId: newVisaCase.branchId });
    // Named Domain Event, never published anywhere — this is the exact
    // moment the case's workflow genuinely starts.
    publishEvent(VISA_DOMAIN_EVENTS.WORKFLOW_STARTED, { visaCaseId: newVisaCase._id, tenantId, branchId: newVisaCase.branchId, initialState: initialWorkflowState });

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
      search,
      sort = "createdAt",
      order = "desc"
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

    // Business Rule "Sorting" — was previously a hardcoded .sort({createdAt:-1})
    // with no query-param support at all. Whitelisted against indexed,
    // client-meaningful fields rather than passing the sort key through raw.
    const sortableFields = new Set(["createdAt", "updatedAt", "caseNumber", "status", "priority", "destinationCountry", "plannedTravelDate"]);
    const sortField = sortableFields.has(sort) ? sort : "createdAt";
    const dbSort = { [sortField]: order === "asc" ? 1 : -1 };

    const [items, total] = await Promise.all([
      VisaCaseModel.find(filter)
        .sort(dbSort)
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
   * Full Aggregate View for GET /visa-cases/:id. The doc's Business Rules
   * explicitly call this an "Aggregate View," but getVisaCaseById alone just
   * returns the raw Visa Case document — Uploaded Documents (full version
   * history, kept in EnterpriseDocumentModel, a separate collection) and
   * Audit Summary were both entirely absent from the response. Kept as a
   * separate method (not a change to getVisaCaseById itself) since that
   * method is used internally elsewhere as a mutable Mongoose document to
   * call .save() on.
   */
  static async getVisaCaseAggregate(visaCaseId, tenantId, branchId) {
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);

    const [uploadedDocuments, auditSummary] = await Promise.all([
      EnterpriseDocumentModel.find({ tenantId, referenceId: visaCaseId, isSoftDeleted: { $ne: true } })
        .sort({ updatedAt: -1 })
        .lean(),
      AuditLogModel.find({
        tenantId,
        $or: [
          { resource: "VisaCase", resourceId: visaCaseId.toString() },
          { "details.visaCaseId": visaCaseId.toString() }
        ]
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()
    ]);

    return {
      ...visaCase.toObject(),
      uploadedDocuments,
      auditSummary
    };
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
    const domainEventsToPublish = [];

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
      // VisaPriorityChanged (named in the Domain Event Map) was previously
      // only ever pushed into the case's own embedded timeline array, never
      // published on the real event bus.
      domainEventsToPublish.push(["VisaPriorityChanged", { visaCaseId, tenantId, branchId: visaCase.branchId, previousPriority: visaCase.priority, newPriority: updateData.priority, performedBy: userId }]);
      visaCase.priority = updateData.priority;
    }

    if (updateData.assignedTo && updateData.assignedTo !== visaCase.assignedTo) {
      timelineEvents.push({
        event: "VisaOfficerAssigned",
        description: `Case assigned to officer ${updateData.assignedTo}.`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      domainEventsToPublish.push(["VisaOfficerAssigned", { visaCaseId, tenantId, branchId: visaCase.branchId, assignedTo: updateData.assignedTo, performedBy: userId }]);
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

    publishEvent("VisaCaseUpdated", { visaCaseId, tenantId, branchId: visaCase.branchId, updatedBy: userId });
    for (const [eventName, payload] of domainEventsToPublish) {
      publishEvent(eventName, payload);
    }

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

    publishEvent("VisaCaseArchived", { visaCaseId, caseNumber: visaCase.caseNumber, tenantId, branchId: visaCase.branchId });

    return { message: `Visa Case ${visaCase.caseNumber} archived successfully.` };
  }

  /**
   * Adds an incident to a Visa Case via EnterpriseIncidentEngineService
   */
  static async addVisaCaseIncident(visaCaseId, incidentData, tenantId, branchId, userId) {
    // "Validate Visa Case" / "Visa Case Exists" — was silently swallowed via
    // .catch(() => null), letting an incident be created against a
    // non-existent (or wrong-branch) Visa Case ID with no error at all.
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);

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
   * Returns incidents for a Visa Case. "Supports filtering. Supports
   * pagination. Supports sorting." — query previously hardcoded to just
   * { visaCaseId }, silently dropping any severity/status/sort/page params
   * a caller sent even though EnterpriseIncidentEngineService.getIncidents
   * already supports all of them.
   */
  static async getVisaCaseIncidents(visaCaseId, query, tenantId, branchId) {
    const result = await EnterpriseIncidentEngineService.getIncidents({ ...query, visaCaseId }, tenantId);
    if (result && Array.isArray(result.items) && result.items.length > 0) {
      // Response Includes: Incident ID, Incident Number, Category, Severity,
      // Status, Assigned Officer, Created Date, SLA Status, Resolution
      // Status, Priority — the raw Mongoose documents don't name several of
      // these fields the way the doc does.
      const items = result.items.map((inc) => ({
        incidentId: inc._id,
        incidentNumber: inc.incidentNumber,
        category: inc.category,
        type: inc.type,
        severity: inc.severity,
        status: inc.status,
        assignedOfficer: inc.assignedToName || inc.assignedTo || null,
        createdDate: inc.createdAt,
        slaStatus: inc.slaStatus,
        resolutionStatus: ["resolved", "verified", "closed"].includes(inc.status)
          ? inc.status
          : (inc.resolution?.resolutionSummary ? "pending_verification" : "unresolved"),
        priority: inc.priority || "normal"
      }));
      return { items, pagination: result.pagination };
    }
    const visaCase = await this.getVisaCaseById(visaCaseId, tenantId, branchId);
    const items = Array.isArray(visaCase.incidents) ? visaCase.incidents : [];
    return { items, pagination: { page: 1, pageSize: items.length, totalItems: items.length, totalPages: 1 } };
  }

  /**
   * Returns complete activity timeline for a Visa Case
   */
  static async getVisaCaseTimeline(visaCaseId, query, tenantId, branchId, requester = {}) {
    await this.getVisaCaseById(visaCaseId, tenantId, branchId);
    return EnterpriseTimelineEngineService.getTimeline({ visaCaseId, branchId, ...query }, tenantId, requester);
  }

  /**
   * Adds a manual operational note to a Visa Case
   */
  static async addVisaCaseNote(visaCaseId, noteData, tenantId, branchId, userId, requestContext = {}, userName = "Staff", userRole = "Staff") {
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
      // branchId is a required, descriptive stamp on the timeline event —
      // inherit the case's own real branchId rather than a caller-omitted
      // null (which fails TravelTimelineModel's schema validation) or a
      // hardcoded "main" (which is wrong for any other branch).
      branchId: branchId || visaCase.branchId,
      userId,
      userName,
      userRole,
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
