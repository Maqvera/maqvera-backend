import VisaService from "../services/VisaService.js";
import VisaRequirementService from "../services/VisaRequirementService.js";
import EnterpriseDocumentService from "../services/EnterpriseDocumentService.js";
import DocumentVerificationService from "../services/DocumentVerificationService.js";
import EmbassyProcessingService from "../services/EmbassyProcessingService.js";
import SchedulingEngineService from "../services/SchedulingEngineService.js";
import VisaWorkflowService from "../services/VisaWorkflowService.js";
import PassportTrackingEngineService from "../services/PassportTrackingEngineService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import EnterpriseTimelineEngineService from "../services/EnterpriseTimelineEngineService.js";

/**
 * GET /api/v1/visa-cases
 * Query parameters: page, pageSize, status, countryId, destinationCountry, visaTypeId, visaType, branchId, travelerId, assignedTo, createdFrom, createdTo, search
 */
export const getVisaCases = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.query.branchId || req.auth?.branchId || req.headers["x-branch-id"] || null;

    const result = await VisaService.getVisaCases(req.query, tenantId, branchId);
    return sendSuccess(res, 200, "Visa Cases retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getVisaCases error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve Visa Cases.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases
 * Creates a new Visa Case and initial Visa Application
 */
export const createVisaCase = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || req.body.branchId || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";

    const visaCase = await VisaService.createVisaCase(req.body, tenantId, branchId, userId);
    return sendSuccess(res, 201, "Visa Case created successfully.", visaCase, requestId);
  } catch (error) {
    console.error("createVisaCase error:", error);
    const statusCode = error.message?.includes("already exists") ? 409 : error.message?.includes("required") || error.message?.includes("not found") ? 400 : 500;
    return sendError(res, statusCode, error.message || "Failed to create Visa Case.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId
 * Returns complete Visa Case aggregate view
 */
export const getVisaCaseById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const visaCase = await VisaService.getVisaCaseById(visaCaseId, tenantId, branchId);
    return sendSuccess(res, 200, "Visa Case details retrieved successfully.", visaCase, requestId);
  } catch (error) {
    console.error("getVisaCaseById error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve Visa Case.", requestId);
  }
};

/**
 * GET /api/v1/workflows/visa
 * Returns the active workflow definition for visa cases.
 */
export const getVisaWorkflowDefinition = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    return sendSuccess(res, 200, "Visa workflow definition retrieved successfully.", VisaWorkflowService.getWorkflowDefinition(), requestId);
  } catch (error) {
    console.error("getVisaWorkflowDefinition error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve visa workflow definition.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/workflow
 * Returns current workflow state and history for a visa case.
 */
export const getVisaCaseWorkflow = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const visaCase = await VisaService.getVisaCaseById(visaCaseId, tenantId, branchId);
    return sendSuccess(res, 200, "Visa workflow details retrieved successfully.", {
      visaCaseId,
      currentState: visaCase.workflow?.currentStep || visaCase.status,
      previousState: visaCase.workflow?.previousStep || null,
      history: Array.isArray(visaCase.timeline) ? visaCase.timeline : [],
      definition: VisaWorkflowService.getWorkflowDefinition()
    }, requestId);
  } catch (error) {
    console.error("getVisaCaseWorkflow error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve visa workflow details.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/workflow/transition
 * Executes a workflow transition for a visa case.
 */
export const transitionVisaCaseWorkflow = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const userId = req.auth?.userId || req.auth?.id || "system";
    const userRoles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
    const { visaCaseId } = req.params;
    const { targetState, remarks } = req.body;

    if (!targetState) {
      return sendError(res, 400, "targetState is required.", requestId);
    }

    const visaCase = await VisaService.getVisaCaseById(visaCaseId, tenantId, branchId);
    const result = await VisaWorkflowService.applyTransition({
      visaCase,
      targetState,
      userRoles,
      performedBy: userId,
      remarks
    });

    await visaCase.save();

    return sendSuccess(res, 200, "Visa workflow transition completed successfully.", {
      previousState: result.previousState,
      currentState: result.currentState,
      transition: result.transition,
      timelineEntry: result.timelineEntry
    }, requestId);
  } catch (error) {
    console.error("transitionVisaCaseWorkflow error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : error.message?.includes("required") ? 400 : 400;
    return sendError(res, statusCode, error.message || "Failed to transition visa workflow.", requestId);
  }
};

/**
 * PATCH /api/v1/visa-cases/:visaCaseId
 * Updates Visa Case information (priority, assignedTo, status, notes, etc.)
 */
export const updateVisaCase = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const updatedCase = await VisaService.updateVisaCase(visaCaseId, req.body, tenantId, branchId, userId);
    return sendSuccess(res, 200, "Visa Case updated successfully.", updatedCase, requestId);
  } catch (error) {
    console.error("updateVisaCase error:", error);
    const statusCode = error.message?.includes("locked") ? 403 : error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to update Visa Case.", requestId);
  }
};

/**
 * DELETE /api/v1/visa-cases/:visaCaseId
 * Soft deletes / archives a Visa Case
 */
export const deleteVisaCase = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const result = await VisaService.deleteVisaCase(visaCaseId, tenantId, branchId, userId);
    return sendSuccess(res, 200, result.message, result, requestId);
  } catch (error) {
    console.error("deleteVisaCase error:", error);
    const statusCode = error.message?.includes("cannot be deleted") ? 403 : error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to archive Visa Case.", requestId);
  }
};

/**
 * GET /api/v1/visa-types
 * Returns all supported visa types catalog
 */
export const getVisaTypes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const result = await VisaRequirementService.getVisaTypes(req.query, tenantId);
    return sendSuccess(res, 200, "Visa types retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getVisaTypes error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve visa types.", requestId);
  }
};

/**
 * GET /api/v1/countries/:countryId/visa-requirements
 * Returns requirement profiles for a destination country via Rule Engine
 */
export const getCountryVisaRequirements = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const { countryId } = req.params;
    const result = await VisaRequirementService.getRequirementProfilesForCountry(countryId, req.query, tenantId);
    return sendSuccess(res, 200, "Visa requirements resolved successfully.", result, requestId);
  } catch (error) {
    console.error("getCountryVisaRequirements error:", error);
    return sendError(res, 500, error.message || "Failed to resolve visa requirements.", requestId);
  }
};

/**
 * POST /api/v1/requirement-profiles
 * Creates a configurable requirement profile
 */
export const createRequirementProfile = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";

    const profile = await VisaRequirementService.createRequirementProfile(req.body, tenantId, userId);
    return sendSuccess(res, 201, "Requirement profile created successfully.", profile, requestId);
  } catch (error) {
    console.error("createRequirementProfile error:", error);
    const statusCode = error.message?.includes("required") ? 400 : 500;
    return sendError(res, statusCode, error.message || "Failed to create requirement profile.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/documents
 * Returns all required and uploaded documents for a Visa Case
 */
export const getVisaCaseDocuments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const result = await EnterpriseDocumentService.getVisaCaseDocuments(visaCaseId, tenantId, branchId);
    return sendSuccess(res, 200, "Visa Case documents retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getVisaCaseDocuments error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve documents.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/documents
 * Uploads a document for a Visa Case (with versioning, OCR & AI queueing)
 */
export const uploadVisaCaseDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const result = await EnterpriseDocumentService.uploadVisaCaseDocument(
      { ...req.body, visaCaseId },
      tenantId,
      branchId,
      userId
    );
    return sendSuccess(res, 201, "Document uploaded successfully.", result, requestId);
  } catch (error) {
    console.error("uploadVisaCaseDocument error:", error);
    const statusCode = error.message?.includes("required") ? 400 : error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to upload document.", requestId);
  }
};

/**
 * GET /api/v1/documents/:documentId
 * Returns document metadata and temporary signed download URL
 */
export const getDocumentById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const { documentId } = req.params;

    const result = await EnterpriseDocumentService.getDocumentById(documentId, tenantId);
    return sendSuccess(res, 200, "Document metadata retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getDocumentById error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve document metadata.", requestId);
  }
};

/**
 * PATCH /api/v1/documents/:documentId
 * Updates document metadata (expiry date, remarks, category, visibility, tags)
 */
export const updateDocumentMetadata = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { documentId } = req.params;

    const result = await EnterpriseDocumentService.updateDocumentMetadata(documentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Document metadata updated successfully.", result, requestId);
  } catch (error) {
    console.error("updateDocumentMetadata error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to update document metadata.", requestId);
  }
};

/**
 * DELETE /api/v1/documents/:documentId
 * Soft deletes / archives a document
 */
export const archiveDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { documentId } = req.params;

    const result = await EnterpriseDocumentService.archiveDocument(documentId, tenantId, userId);
    return sendSuccess(res, 200, result.message, result, requestId);
  } catch (error) {
    console.error("archiveDocument error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to archive document.", requestId);
  }
};

/**
 * POST /api/v1/documents/:documentId/verification/start
 * Starts multi-stage document verification pipeline
 */
export const startDocumentVerification = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { documentId } = req.params;

    const result = await DocumentVerificationService.startVerification(documentId, tenantId, branchId, userId);
    return sendSuccess(res, 200, "Document verification pipeline started.", result, requestId);
  } catch (error) {
    console.error("startDocumentVerification error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to start verification.", requestId);
  }
};

/**
 * GET /api/v1/documents/:documentId/verification
 * Returns complete verification details and independent stage results
 */
export const getDocumentVerificationDetails = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const { documentId } = req.params;

    const result = await DocumentVerificationService.getVerificationDetails(documentId, tenantId);
    return sendSuccess(res, 200, "Document verification details retrieved.", result, requestId);
  } catch (error) {
    console.error("getDocumentVerificationDetails error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve verification details.", requestId);
  }
};

/**
 * POST /api/v1/documents/:documentId/verification/manual-review
 * Submits manual officer review decision
 */
export const submitManualDocumentReview = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { documentId } = req.params;

    const result = await DocumentVerificationService.submitManualReview(documentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Manual review submitted successfully.", result, requestId);
  } catch (error) {
    console.error("submitManualDocumentReview error:", error);
    const statusCode = error.message?.includes("required") ? 400 : error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to submit manual review.", requestId);
  }
};

/**
 * POST /api/v1/documents/:documentId/verification/reverify
 * Restarts verification pipeline for the latest document version
 */
export const reverifyDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { documentId } = req.params;

    const result = await DocumentVerificationService.reverifyDocument(documentId, tenantId, userId);
    return sendSuccess(res, 200, "Document reverification pipeline started.", result, requestId);
  } catch (error) {
    console.error("reverifyDocument error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to restart verification.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/embassy-submissions
 * Creates an embassy submission for a Visa Case
 */
export const createEmbassySubmission = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const result = await EmbassyProcessingService.createEmbassySubmission(visaCaseId, req.body, tenantId, branchId, userId);
    return sendSuccess(res, 201, "Embassy submission created successfully.", result, requestId);
  } catch (error) {
    console.error("createEmbassySubmission error:", error);
    const statusCode = error.message?.includes("already exists") ? 409 : error.message?.includes("required") || error.message?.includes("not found") ? 400 : 500;
    return sendError(res, statusCode, error.message || "Failed to create embassy submission.", requestId);
  }
};

/**
 * GET /api/v1/embassy-submissions/:submissionId
 * Returns complete embassy submission details, SLA tracking, courier status, and timeline
 */
export const getEmbassySubmissionById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const { submissionId } = req.params;

    const result = await EmbassyProcessingService.getEmbassySubmissionById(submissionId, tenantId);
    return sendSuccess(res, 200, "Embassy submission details retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getEmbassySubmissionById error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve embassy submission.", requestId);
  }
};

/**
 * PATCH /api/v1/embassy-submissions/:submissionId
 * Updates embassy processing status, expected completion date, or tracking number
 */
export const updateEmbassySubmission = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { submissionId } = req.params;

    const result = await EmbassyProcessingService.updateEmbassySubmission(submissionId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Embassy submission updated successfully.", result, requestId);
  } catch (error) {
    console.error("updateEmbassySubmission error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to update embassy submission.", requestId);
  }
};

/**
 * POST /api/v1/embassy-submissions/:submissionId/additional-documents
 * Registers an additional document request from the embassy
 */
export const requestAdditionalDocuments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { submissionId } = req.params;

    const result = await EmbassyProcessingService.requestAdditionalDocuments(submissionId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Additional document request registered.", result, requestId);
  } catch (error) {
    console.error("requestAdditionalDocuments error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to register document request.", requestId);
  }
};

/**
 * POST /api/v1/embassy-submissions/:submissionId/decision
 * Registers an embassy decision (Approved, Rejected, Returned, etc.)
 */
export const registerEmbassyDecision = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { submissionId } = req.params;

    const result = await EmbassyProcessingService.registerEmbassyDecision(submissionId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Embassy decision registered successfully.", result, requestId);
  } catch (error) {
    console.error("registerEmbassyDecision error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to register embassy decision.", requestId);
  }
};

/**
 * POST /api/v1/embassy-submissions/batches
 * Creates a Submission Batch Queue for dispatching multiple cases together
 */
export const createSubmissionBatch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";

    const result = await EmbassyProcessingService.createSubmissionBatch(req.body, tenantId, branchId, userId);
    return sendSuccess(res, 201, "Embassy submission batch created successfully.", result, requestId);
  } catch (error) {
    console.error("createSubmissionBatch error:", error);
    const statusCode = error.message?.includes("required") ? 400 : 500;
    return sendError(res, statusCode, error.message || "Failed to create submission batch.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/appointments
 * Returns all appointments for a Visa Case
 */
export const getVisaCaseAppointments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const result = await SchedulingEngineService.getAppointmentsForCase(visaCaseId, req.query, tenantId, branchId);
    return sendSuccess(res, 200, "Appointments retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getVisaCaseAppointments error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve appointments.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/appointments
 * Schedules a new appointment with capacity validation & conflict check
 */
export const scheduleVisaCaseAppointment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const result = await SchedulingEngineService.scheduleAppointment(visaCaseId, req.body, tenantId, branchId, userId);
    return sendSuccess(res, 201, "Appointment scheduled successfully.", result, requestId);
  } catch (error) {
    console.error("scheduleVisaCaseAppointment error:", error);
    const statusCode = error.message?.includes("already booked") || error.message?.includes("unavailable") ? 409 : error.message?.includes("required") || error.message?.includes("not found") ? 400 : 500;
    return sendError(res, statusCode, error.message || "Failed to schedule appointment.", requestId);
  }
};

/**
 * PATCH /api/v1/appointments/:appointmentId
 * Updates or reschedules appointment details
 */
export const updateAppointment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { appointmentId } = req.params;

    const result = await SchedulingEngineService.updateAppointment(appointmentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Appointment updated successfully.", result, requestId);
  } catch (error) {
    console.error("updateAppointment error:", error);
    const statusCode = error.message?.includes("cannot be modified") ? 403 : error.message?.includes("unavailable") ? 409 : error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to update appointment.", requestId);
  }
};

/**
 * POST /api/v1/appointments/:appointmentId/attendance
 * Marks attendance status (Checked In, Present, Completed, No Show, etc.)
 */
export const recordAppointmentAttendance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { appointmentId } = req.params;

    const result = await SchedulingEngineService.recordAttendance(appointmentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Attendance recorded successfully.", result, requestId);
  } catch (error) {
    console.error("recordAppointmentAttendance error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to record attendance.", requestId);
  }
};

/**
 * POST /api/v1/appointments/:appointmentId/result
 * Records appointment outcome (Interview Passed, Biometric Completed, Medical Failed, etc.)
 */
export const recordAppointmentResult = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { appointmentId } = req.params;

    const result = await SchedulingEngineService.recordAppointmentResult(appointmentId, req.body, tenantId, userId);
    return sendSuccess(res, 200, "Appointment outcome result recorded.", result, requestId);
  } catch (error) {
    console.error("recordAppointmentResult error:", error);
    const statusCode = error.message?.includes("required") ? 400 : error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to record result.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/passport
 * Returns passport information and chain of custody tracking history.
 */
export const getVisaCasePassport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const { visaCaseId } = req.params;

    const passport = await PassportTrackingEngineService.getPassportByVisaCaseId(visaCaseId, tenantId);
    return sendSuccess(res, 200, "Passport tracking record retrieved successfully.", passport, requestId);
  } catch (error) {
    console.error("getVisaCasePassport error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve passport tracking.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/passport/receive
 * Registers passport received from traveler.
 */
export const receiveVisaCasePassport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const passport = await PassportTrackingEngineService.receivePassport(
      { visaCaseId, ...req.body },
      tenantId,
      branchId,
      userId
    );
    return sendSuccess(res, 201, "Passport receipt registered successfully.", passport, requestId);
  } catch (error) {
    console.error("receiveVisaCasePassport error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to register passport receipt.", requestId);
  }
};

/**
 * POST /api/v1/passports/:passportId/transfer
 * Transfers passport custody.
 */
export const transferPassportCustody = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { passportId } = req.params;

    const passport = await PassportTrackingEngineService.transferCustody(
      { passportId, ...req.body },
      tenantId,
      userId
    );
    return sendSuccess(res, 200, "Passport custody transferred successfully.", passport, requestId);
  } catch (error) {
    console.error("transferPassportCustody error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to transfer passport custody.", requestId);
  }
};

/**
 * POST /api/v1/passports/:passportId/dispatch
 * Dispatches passport to embassy/VAC via courier.
 */
export const dispatchPassportToEmbassy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { passportId } = req.params;

    const passport = await PassportTrackingEngineService.dispatchToEmbassy(
      { passportId, ...req.body },
      tenantId,
      userId
    );
    return sendSuccess(res, 200, "Passport dispatched to embassy successfully.", passport, requestId);
  } catch (error) {
    console.error("dispatchPassportToEmbassy error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to dispatch passport.", requestId);
  }
};

/**
 * POST /api/v1/passports/:passportId/receive-from-embassy
 * Registers passport returned from embassy.
 */
export const receivePassportFromEmbassy = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { passportId } = req.params;

    const passport = await PassportTrackingEngineService.receiveFromEmbassy(
      { passportId, ...req.body },
      tenantId,
      userId
    );
    return sendSuccess(res, 200, "Passport return from embassy registered.", passport, requestId);
  } catch (error) {
    console.error("receivePassportFromEmbassy error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to register embassy passport return.", requestId);
  }
};

/**
 * POST /api/v1/passports/:passportId/collect
 * Registers passport collection by traveler.
 */
export const collectPassport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { passportId } = req.params;

    const passport = await PassportTrackingEngineService.collectPassport(
      { passportId, ...req.body },
      tenantId,
      userId
    );
    return sendSuccess(res, 200, "Passport collection registered successfully.", passport, requestId);
  } catch (error) {
    console.error("collectPassport error:", error);
    const statusCode = error.message?.includes("verification is mandatory") ? 422 : error.message?.includes("already been collected") ? 409 : error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to register passport collection.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/incidents
 * Returns incidents reported for a Visa Case.
 */
export const getVisaCaseIncidents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const incidents = await VisaService.getVisaCaseIncidents(visaCaseId, tenantId, branchId);
    return sendSuccess(res, 200, "Visa Case incidents retrieved successfully.", incidents, requestId);
  } catch (error) {
    console.error("getVisaCaseIncidents error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve incidents.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/incidents
 * Reports a new operational incident for a Visa Case.
 */
export const reportVisaCaseIncident = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const incident = await VisaService.addVisaCaseIncident(visaCaseId, req.body, tenantId, branchId, userId);
    return sendSuccess(res, 201, "Incident reported successfully.", incident, requestId);
  } catch (error) {
    console.error("reportVisaCaseIncident error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to report incident.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/timeline
 * Returns the complete activity history of a Visa Case.
 */
export const getVisaCaseTimeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const timelineData = await VisaService.getVisaCaseTimeline(visaCaseId, req.query, tenantId, branchId);
    return res.status(200).json({
      success: true,
      data: timelineData.items || timelineData,
      meta: timelineData.pagination || {},
      requestId
    });
  } catch (error) {
    console.error("getVisaCaseTimeline error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to retrieve visa case timeline.", requestId);
  }
};

/**
 * POST /api/v1/visa-cases/:visaCaseId/notes
 * Creates a manual operational note for a Visa Case.
 */
export const addVisaCaseNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || "main";
    const userId = req.auth?.userId || req.auth?.id || "system";
    const { visaCaseId } = req.params;

    const note = await VisaService.addVisaCaseNote(visaCaseId, req.body, tenantId, branchId, userId, {
      requestId,
      ipAddress: req.ip,
      device: req.get("user-agent") || null
    });
    return sendSuccess(res, 201, "Manual note created successfully.", note, requestId);
  } catch (error) {
    console.error("addVisaCaseNote error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 400;
    return sendError(res, statusCode, error.message || "Failed to create note.", requestId);
  }
};

/**
 * GET /api/v1/visa-cases/:visaCaseId/ai-context
 * Returns aggregated AI prompt context derived from timeline history.
 */
export const getVisaCaseAIContext = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const branchId = req.auth?.branchId || req.headers["x-branch-id"] || null;
    const { visaCaseId } = req.params;

    const aiContext = await VisaService.getVisaCaseAIContext(visaCaseId, tenantId, branchId);
    return sendSuccess(res, 200, "AI context generated successfully.", aiContext, requestId);
  } catch (error) {
    console.error("getVisaCaseAIContext error:", error);
    const statusCode = error.message?.includes("not found") ? 404 : 500;
    return sendError(res, statusCode, error.message || "Failed to generate AI context.", requestId);
  }
};

/** GET /api/v1/timeline/:eventId - immutable event detail. */
export const getTimelineEventById = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId || req.headers["x-tenant-id"] || "default-tenant";
    const event = await EnterpriseTimelineEngineService.getEventById(req.params.eventId, tenantId);
    return sendSuccess(res, 200, "Timeline event retrieved successfully.", event, requestId);
  } catch (error) {
    return sendError(res, error.message?.includes("not found") ? 404 : 500, error.message || "Failed to retrieve timeline event.", requestId);
  }
};


