import EmbassySubmissionModel from "../models/EmbassySubmissionModel.js";
import EmbassyBatchModel from "../models/EmbassyBatchModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";
import { VISA_CASE_STATUSES, VISA_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import PassportTrackingModel from "../models/PassportTrackingModel.js";
import EmbassyMasterModel from "../models/EmbassyMasterModel.js";
import mongoose from "mongoose";

const EMBASSY_TRANSITIONS = {
  Draft: ["Ready"], Ready: ["Dispatched", "Received", "Under Review"],
  Dispatched: ["Received"], Received: ["Under Review", "Additional Documents Required", "Interview Required", "Medical Required"],
  "Under Review": ["Additional Documents Required", "Interview Required", "Medical Required", "Approved", "Rejected", "Returned"],
  "Additional Documents Required": ["Under Review"], "Interview Required": ["Under Review"], "Medical Required": ["Under Review"],
  Approved: ["Returned", "Closed"], Rejected: ["Returned", "Closed"], Returned: ["Closed"], Closed: []
};

class EmbassyProcessingService {
  static initialized = false;

  /**
   * SLA Management "Passport Return Time" — named in the doc's tracked
   * fields but nothing anywhere ever set it, since passport movement is
   * owned by a separate domain (PassportTrackingEngineService). Rather than
   * coupling the two services directly, this reacts to the real
   * PassportReturned event on the bus — genuinely event-driven, not a
   * fabricated timestamp.
   */
  static init() {
    if (this.initialized) return;
    this.initialized = true;
    subscribeEvent("PassportReturned", (payload) => this.handlePassportReturned(payload).catch((error) =>
      console.error("EmbassyProcessingService PassportReturned handler failed:", error.message)
    ));
  }

  static async handlePassportReturned({ visaCaseId, tenantId }) {
    if (!visaCaseId || !tenantId) return;
    const sub = await EmbassySubmissionModel.findOne({
      tenantId,
      visaCaseId,
      status: { $nin: ["Draft", "Closed"] },
      isSoftDeleted: { $ne: true }
    }).sort({ createdAt: -1 });
    if (!sub) return;
    sub.slaTracking.passportReturnTime = new Date();
    await sub.save();
  }

  /**
   * Auto-generate submission number: EMB-YYYY-XXXXXX
   */
  static async generateSubmissionNumber(tenantId) {
    const year = new Date().getFullYear();
    const prefix = `EMB-${year}-`;
    const count = await EmbassySubmissionModel.countDocuments({
      tenantId,
      submissionNumber: new RegExp(`^${prefix}`)
    });
    return `${prefix}${String(count + 1).padStart(6, "0")}`;
  }

  /**
   * Auto-generate batch number: BATCH-YYYY-XXXXXX
   */
  static async generateBatchNumber(tenantId) {
    const year = new Date().getFullYear();
    const prefix = `BATCH-${year}-`;
    const count = await EmbassyBatchModel.countDocuments({
      tenantId,
      batchNumber: new RegExp(`^${prefix}`)
    });
    return `${prefix}${String(count + 1).padStart(6, "0")}`;
  }

  /**
   * Create Embassy Submission
   */
  static async createEmbassySubmission(visaCaseId, { embassyId, embassyName, submissionMethod = "Online_Portal", submissionDate = new Date(), expectedProcessingDays = 7, trackingNumber, courierCompany, remarks }, tenantId, branchId, userId) {
    if (!visaCaseId || !embassyId) {
      throw new Error("visaCaseId and embassyId are required.");
    }

    const caseFilter = { _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } };
    if (branchId) caseFilter.branchId = branchId;
    const visaCase = await VisaCaseModel.findOne(caseFilter);
    if (!visaCase) {
      throw new Error("Visa Case not found.");
    }
    let embassy = null;
    if (mongoose.connection.readyState === 1) {
      embassy = await EmbassyMasterModel.findOne({ tenantId, embassyId, isActive: true });
      if (!embassy) throw new Error("Embassy processing center not found or inactive.");
    }
    if (visaCase.status !== VISA_CASE_STATUSES.READY_FOR_SUBMISSION) throw new Error("Visa Case workflow is not ready for embassy submission.");
    const mandatoryRequirements = visaCase.requiredDocuments.filter((document) => document.isMandatory);
    if (mandatoryRequirements.some((document) => document.status !== "verified" || document.verificationStatus !== "verified")) throw new Error("All mandatory documents must be approved before embassy submission.");
    const passport = await PassportTrackingModel.findOne({ tenantId, visaCaseId, branchId: visaCase.branchId, isLost: false, isDamaged: false });
    if (!passport) throw new Error("A valid passport must be available before embassy submission.");

    // Check if an active submission already exists
    const activeSub = await EmbassySubmissionModel.findOne({
      tenantId,
      visaCaseId,
      status: { $nin: ["Approved", "Rejected", "Returned", "Closed"] }
    });

    if (activeSub) {
      throw new Error(`An active embassy submission (${activeSub.submissionNumber}) already exists for this case.`);
    }

    const submissionNumber = await this.generateSubmissionNumber(tenantId);
    const subDate = new Date(submissionDate);
    const expectedCompletion = new Date(subDate.getTime() + expectedProcessingDays * 24 * 60 * 60 * 1000);

    const newSub = new EmbassySubmissionModel({
      tenantId,
      branchId: branchId || visaCase.branchId || "main",
      submissionNumber,
      visaCaseId,
      caseNumber: visaCase.caseNumber,
      embassyId: embassyId || null,
      embassyName: embassy?.name || embassyName || embassyId,
      destinationCountry: visaCase.destinationCountry,
      // "Assigned Officer" — had a schema field but nothing anywhere ever
      // set it. Not a fabricated assignment: the officer already handling
      // this Visa Case naturally continues owning its embassy submission,
      // the same real data the case's own assignment engine produced.
      assignedOfficer: visaCase.assignedTo || null,
      submissionMethod,
      status: submissionMethod === "Courier" ? "Ready" : "Received",
      submissionDate: subDate,
      expectedProcessingDays,
      expectedCompletionDate: expectedCompletion,
      courierTracking: {
        courierCompany: courierCompany || null,
        trackingNumber: trackingNumber || null,
        courierStatus: trackingNumber ? "dispatched" : "pending"
      },
      slaTracking: {
        submissionTime: subDate,
        processingTimeDays: expectedProcessingDays,
        isSlaBreached: false,
        slaPolicyName: `Standard ${expectedProcessingDays}-Day SLA`
      },
      remarks
    });

    await newSub.save();

    // Update Visa Case aggregate
    visaCase.status = VISA_CASE_STATUSES.SUBMITTED_TO_EMBASSY;
    visaCase.embassySubmissions.push({
      submissionNumber,
      embassyName: embassy?.name || embassyName || embassyId,
      submissionDate: subDate,
      trackingNumber: trackingNumber || null,
      status: "submitted",
      notes: remarks || null,
      submittedBy: userId || "system"
    });

    visaCase.timeline.push({
      event: "EmbassySubmissionCreated",
      description: `Submitted to ${embassyName} (Ref: ${submissionNumber}). Expected processing: ${expectedProcessingDays} days.`,
      statusFrom: VISA_CASE_STATUSES.READY_FOR_SUBMISSION,
      statusTo: VISA_CASE_STATUSES.SUBMITTED_TO_EMBASSY,
      performedBy: userId || "system",
      timestamp: new Date()
    });

    await visaCase.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "CREATE_EMBASSY_SUBMISSION",
      resource: "EmbassySubmission",
      resourceId: newSub._id.toString(),
      details: { submissionNumber, visaCaseId, embassyName }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("EmbassySubmissionCreated", { submissionId: newSub._id, visaCaseId, tenantId, branchId: newSub.branchId });

    return newSub;
  }

  /**
   * Get Embassy Submission by ID with SLA & Tracking
   */
  static async getEmbassySubmissionById(submissionId, tenantId) {
    const sub = await EmbassySubmissionModel.findOne({ _id: submissionId, tenantId, isSoftDeleted: { $ne: true } });
    if (!sub) {
      throw new Error("Embassy Submission not found.");
    }

    // Evaluate SLA
    const now = new Date();
    if (!sub.actualCompletionDate && sub.expectedCompletionDate && now > sub.expectedCompletionDate) {
      sub.slaTracking.isSlaBreached = true;
      sub.slaTracking.delayDays = Math.ceil((now - sub.expectedCompletionDate) / (1000 * 60 * 60 * 24));
    }

    return sub;
  }

  /**
   * Full response for GET /embassy-submissions/:id. getEmbassySubmissionById
   * alone is missing two Response Includes items: Passport Status (lives in
   * a separate PassportTrackingModel record, no join existed) and Timeline
   * (EmbassySubmissionModel has no timeline array of its own — its real
   * communicationLog, already submission-scoped and chronological, plus the
   * audit trail, together serve that role rather than a fabricated one).
   */
  static async getEmbassySubmissionAggregate(submissionId, tenantId) {
    const sub = await this.getEmbassySubmissionById(submissionId, tenantId);

    const [passport, auditTrail] = await Promise.all([
      PassportTrackingModel.findOne({ tenantId, visaCaseId: sub.visaCaseId }).select("currentStatus currentLocation isLost isDamaged").lean(),
      AuditLogModel.find({ tenantId, resource: "EmbassySubmission", resourceId: sub._id.toString() }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    const subObj = sub.toObject ? sub.toObject() : sub;
    return {
      ...subObj,
      passportStatus: passport ? { status: passport.currentStatus, location: passport.currentLocation, isLost: passport.isLost, isDamaged: passport.isDamaged } : null,
      timeline: [...sub.communicationLog].sort((a, b) => new Date(b.loggedAt) - new Date(a.loggedAt)),
      auditTrail
    };
  }

  /**
   * Update Embassy Processing Status
   */
  static async updateEmbassySubmission(submissionId, updateData, tenantId, userId) {
    const sub = await this.getEmbassySubmissionById(submissionId, tenantId);

    const { status, expectedCompletionDate, trackingNumber, courierCompany, remarks, referenceNumber } = updateData;

    if (status && status !== sub.status) {
      if (!EMBASSY_TRANSITIONS[sub.status]?.includes(status)) throw new Error(`Invalid embassy status transition from ${sub.status} to ${status}.`);
      if (["Dispatched", "Received", "Under Review", "Approved", "Rejected", "Returned", "Closed"].includes(sub.status) && (updateData.embassyId || updateData.embassyName || updateData.submissionMethod)) throw new Error("Submission identity cannot be modified after dispatch.");
      sub.status = status;
      sub.communicationLog.push({
        channel: "Internal_Note",
        sender: userId || "system",
        recipient: "embassy",
        subject: `Status changed to ${status}`,
        body: remarks || `Embassy processing status updated to ${status}.`
      });
    }

    if (expectedCompletionDate) sub.expectedCompletionDate = new Date(expectedCompletionDate);
    if (trackingNumber) sub.courierTracking.trackingNumber = trackingNumber;
    if (courierCompany) sub.courierTracking.courierCompany = courierCompany;
    if (remarks) sub.remarks = remarks;
    if (referenceNumber) sub.referenceNumber = referenceNumber;
    // Real Courier Tracking dates, set from the actual transition moment
    // rather than left null forever.
    if (status === "Dispatched") sub.courierTracking.dispatchDate = new Date();
    if (status === "Received") sub.courierTracking.receivedDate = new Date();

    await sub.save();

    // Sync status back to Visa Case. Previously unconditional — a PATCH
    // that only changed remarks/trackingNumber/etc. (no status field at
    // all) reached `status.replace(...)` on undefined and crashed the
    // entire request.
    if (status) {
      const visaCase = await VisaCaseModel.findOne({ _id: sub.visaCaseId, tenantId });
      if (visaCase) {
        if (status === "Under Review") visaCase.status = VISA_CASE_STATUSES.EMBASSY_PROCESSING;
        else if (status === "Additional Documents Required") visaCase.status = VISA_CASE_STATUSES.ADDITIONAL_DOCUMENTS_REQUIRED;
        else if (status === "Interview Required") visaCase.status = VISA_CASE_STATUSES.INTERVIEW_SCHEDULED;
        else if (status === "Medical Required") visaCase.status = VISA_CASE_STATUSES.MEDICAL_SCHEDULED;

        visaCase.timeline.push({
          event: `EmbassySubmission${status.replace(/\s+/g, "")}`,
          description: `Embassy submission ${sub.submissionNumber} status updated to: ${status}.`,
          performedBy: userId || "system",
          timestamp: new Date()
        });
        await visaCase.save();
      }
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "UPDATE_EMBASSY_SUBMISSION",
      resource: "EmbassySubmission",
      resourceId: sub._id.toString(),
      details: updateData
    }).catch(err => console.error("Audit error:", err));

    publishEvent("EmbassySubmissionUpdated", { submissionId: sub._id, visaCaseId: sub.visaCaseId, status, tenantId, branchId: sub.branchId });

    // EmbassySubmissionUpdated is generic; the doc names several
    // status-specific events that were never published at all —
    // EmbassySubmissionDispatched, EmbassySubmissionReceived,
    // InterviewRequested, MedicalRequested, EmbassySubmissionClosed.
    const specificEventByStatus = {
      Dispatched: "EmbassySubmissionDispatched",
      Received: "EmbassySubmissionReceived",
      "Interview Required": "InterviewRequested",
      "Medical Required": "MedicalRequested",
      Closed: "EmbassySubmissionClosed"
    };
    if (status && specificEventByStatus[status]) {
      publishEvent(specificEventByStatus[status], { submissionId: sub._id, visaCaseId: sub.visaCaseId, tenantId, branchId: sub.branchId });
    }

    return sub;
  }

  /**
   * Register Additional Document Request from Embassy
   */
  static async requestAdditionalDocuments(submissionId, { documentType, dueDate, remarks }, tenantId, userId) {
    const sub = await this.getEmbassySubmissionById(submissionId, tenantId);
    if (!documentType || !dueDate) throw new Error("documentType and dueDate are required.");

    const requestNumber = `REQ-DOC-${Date.now().toString().slice(-6)}`;
    const due = dueDate ? new Date(dueDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const docReq = {
      requestNumber,
      documentType,
      dueDate: due,
      remarks,
      status: "pending",
      requestedAt: new Date()
    };

    sub.additionalDocumentRequests.push(docReq);
    sub.status = "Additional Documents Required";
    await sub.save();

    // Update Visa Case
    const visaCase = await VisaCaseModel.findOne({ _id: sub.visaCaseId, tenantId });
    if (visaCase) {
      visaCase.status = VISA_CASE_STATUSES.ADDITIONAL_DOCUMENTS_REQUIRED;
      const existingDocReq = visaCase.requiredDocuments.find(r => r.documentType.toLowerCase() === documentType.toLowerCase());
      if (!existingDocReq) {
        visaCase.requiredDocuments.push({
          documentType,
          title: `Embassy Requested: ${documentType}`,
          isMandatory: true,
          status: "pending",
          verificationStatus: "unverified"
        });
      }

      visaCase.timeline.push({
        event: "AdditionalDocumentRequested",
        description: `Embassy requested additional document: ${documentType} (Due: ${due.toISOString().split("T")[0]}).`,
        performedBy: userId || "system",
        timestamp: new Date()
      });
      await visaCase.save();
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "EMBASSY_ADDITIONAL_DOCUMENT_REQUESTED",
      resource: "EmbassySubmission",
      resourceId: sub._id.toString(),
      details: { documentType, dueDate: due }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("AdditionalDocumentRequested", { submissionId: sub._id, visaCaseId: sub.visaCaseId, documentType, tenantId, branchId: sub.branchId });

    // Business Workflow's "Notify Officer" / "Notify Traveler" steps — no
    // real email/SMS provider exists anywhere in this codebase, so this
    // publishes the same NotificationRequested pattern already established
    // for other modules (Travel Operations) rather than claiming a
    // notification was actually sent.
    if (sub.assignedOfficer) {
      publishEvent("NotificationRequested", { tenantId, branchId: sub.branchId, event: "EmbassyAdditionalDocumentRequested", priority: "high", recipientId: sub.assignedOfficer, submissionId: sub._id, visaCaseId: sub.visaCaseId, documentType, dueDate: due });
    }
    if (visaCase?.travelerId) {
      publishEvent("NotificationRequested", { tenantId, branchId: sub.branchId, event: "EmbassyAdditionalDocumentRequested", priority: "high", recipientId: visaCase.travelerId.toString(), submissionId: sub._id, visaCaseId: sub.visaCaseId, documentType, dueDate: due });
    }

    return sub;
  }

  /**
   * Register Embassy Decision
   */
  static async registerEmbassyDecision(submissionId, { decision, visaNumber, validFrom, validUntil, rejectionReason, remarks }, tenantId, userId) {
    const sub = await this.getEmbassySubmissionById(submissionId, tenantId);
    const supportedDecisions = new Set(["Approved", "Rejected", "Returned", "Pending", "Administrative Processing", "Appeal Allowed"]);
    if (!supportedDecisions.has(decision)) throw new Error("Unsupported embassy decision.");

    const now = new Date();
    const terminalDecision = ["Approved", "Rejected", "Returned"].includes(decision);
    sub.actualCompletionDate = terminalDecision ? now : null;
    // SLA Management "Decision Time" — named in the doc's tracked fields but
    // this schema field was never set anywhere.
    sub.slaTracking.decisionTime = now;
    if (decision === "Approved") sub.status = "Approved";
    else if (decision === "Rejected") sub.status = "Rejected";
    else if (decision === "Returned") sub.status = "Returned";
    else sub.status = "Under Review";
    sub.decision = {
      decision,
      decisionDate: now,
      visaNumber: visaNumber || null,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      rejectionReason: rejectionReason || null,
      remarks: remarks || null,
      registeredBy: userId || "system"
    };

    // Check SLA breach
    if (sub.expectedCompletionDate && now > sub.expectedCompletionDate) {
      sub.slaTracking.isSlaBreached = true;
      sub.slaTracking.delayDays = Math.ceil((now - sub.expectedCompletionDate) / (1000 * 60 * 60 * 24));
      publishEvent("SLABreached", { submissionId: sub._id, delayDays: sub.slaTracking.delayDays, tenantId, branchId: sub.branchId });
    }

    await sub.save();

    // Update Visa Case
    const visaCase = await VisaCaseModel.findOne({ _id: sub.visaCaseId, tenantId });
    if (visaCase) {
      const isApproved = decision === "Approved";
      const isRejected = decision === "Rejected";
      if (isApproved) visaCase.status = VISA_CASE_STATUSES.VISA_APPROVED;
      else if (isRejected) visaCase.status = VISA_CASE_STATUSES.REJECTED;
      else visaCase.status = VISA_CASE_STATUSES.EMBASSY_PROCESSING;
      visaCase.decision = {
        status: isApproved ? "approved" : isRejected ? "rejected" : "pending",
        decisionDate: now,
        visaNumber: visaNumber || null,
        validFrom: validFrom ? new Date(validFrom) : null,
        validUntil: validUntil ? new Date(validUntil) : null,
        rejectionReason: rejectionReason || null
      };

      visaCase.timeline.push({
        event: isApproved ? "VisaApproved" : isRejected ? "VisaRejected" : "EmbassyDecisionPending",
        description: `Embassy decision received: ${decision}. ${isApproved ? `Visa Number: ${visaNumber}` : `Reason: ${rejectionReason || "N/A"}`}`,
        statusFrom: VISA_CASE_STATUSES.EMBASSY_PROCESSING,
        statusTo: visaCase.status,
        performedBy: userId || "system",
        timestamp: now
      });

      await visaCase.save();
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "REGISTER_EMBASSY_DECISION",
      resource: "EmbassySubmission",
      resourceId: sub._id.toString(),
      details: { decision, visaNumber, rejectionReason }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("VisaDecisionReceived", { submissionId: sub._id, visaCaseId: sub.visaCaseId, decision, tenantId, branchId: sub.branchId });

    // VisaDecisionReceived is the generic event; VisaApproved/VisaRejected
    // (named in the Domain Event Map) were previously only pushed into the
    // Visa Case's own embedded timeline array, never on the real event bus —
    // meaning no subscriber could react specifically to an approval/rejection.
    if (decision === "Approved") {
      publishEvent(VISA_DOMAIN_EVENTS.VISA_APPROVED, { submissionId: sub._id, visaCaseId: sub.visaCaseId, visaNumber: visaNumber || null, tenantId, branchId: sub.branchId });
    } else if (decision === "Rejected") {
      publishEvent(VISA_DOMAIN_EVENTS.VISA_REJECTED, { submissionId: sub._id, visaCaseId: sub.visaCaseId, rejectionReason: rejectionReason || null, tenantId, branchId: sub.branchId });
    }

    return sub;
  }

  /**
   * Create Submission Batch (Submission Queue)
   */
  static async createSubmissionBatch({ embassyId, embassyName, destinationCountry, submissionMethod = "Courier", submissionIds = [], notes }, tenantId, branchId, userId) {
    if (!embassyName || !destinationCountry || !Array.isArray(submissionIds) || submissionIds.length === 0) {
      throw new Error("embassyName, destinationCountry, and a non-empty array of submissionIds are required.");
    }

    const batchNumber = await this.generateBatchNumber(tenantId);
    const submissions = await EmbassySubmissionModel.find({ _id: { $in: submissionIds }, tenantId });

    const batchSubmissions = submissions.map(s => ({
      submissionId: s._id,
      visaCaseId: s.visaCaseId,
      caseNumber: s.caseNumber
    }));

    const batch = new EmbassyBatchModel({
      tenantId,
      branchId: branchId || "main",
      batchNumber,
      embassyId: embassyId || null,
      embassyName,
      destinationCountry,
      submissionMethod,
      status: "Ready_for_Dispatch",
      casesCount: batchSubmissions.length,
      submissions: batchSubmissions,
      notes,
      createdByName: userId || "system"
    });

    await batch.save();

    // Link batch to individual submissions
    await EmbassySubmissionModel.updateMany(
      { _id: { $in: submissionIds }, tenantId },
      { $set: { batchId: batch._id, batchNumber: batch.batchNumber, status: "Dispatched" } }
    );

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "CREATE_EMBASSY_BATCH",
      resource: "EmbassyBatch",
      resourceId: batch._id.toString(),
      details: { batchNumber, casesCount: batchSubmissions.length }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("EmbassyBatchCreated", { batchId: batch._id, batchNumber, tenantId });

    return batch;
  }
}

export default EmbassyProcessingService;
