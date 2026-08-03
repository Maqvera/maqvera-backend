import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  getVisaCases,
  createVisaCase,
  getVisaCaseById,
  updateVisaCase,
  deleteVisaCase,
  getVisaTypes,
  getCountryVisaRequirements,
  createRequirementProfile,
  getVisaWorkflowDefinition,
  getVisaCaseWorkflow,
  transitionVisaCaseWorkflow,
  getVisaCaseDocuments,
  uploadVisaCaseDocument,
  getDocumentById,
  updateDocumentMetadata,
  archiveDocument,
  startDocumentVerification,
  getDocumentVerificationDetails,
  submitManualDocumentReview,
  reverifyDocument,
  createEmbassySubmission,
  getEmbassySubmissionById,
  updateEmbassySubmission,
  requestAdditionalDocuments,
  registerEmbassyDecision,
  createSubmissionBatch,
  getVisaCaseAppointments,
  scheduleVisaCaseAppointment,
  updateAppointment,
  recordAppointmentAttendance,
  recordAppointmentResult,
  getVisaCasePassport,
  receiveVisaCasePassport,
  transferPassportCustody,
  dispatchPassportToEmbassy,
  receivePassportFromEmbassy,
  collectPassport,
  getVisaCaseIncidents,
  reportVisaCaseIncident,
  getVisaCaseTimeline,
  addVisaCaseNote,
  getVisaCaseAIContext,
  getTimelineEventById
} from "../controllers/VisaController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
});

// Visa Types Catalog endpoint
router.get("/visa-types", limiter, getVisaTypes);

// Country Visa Requirements Rule Engine endpoint
router.get("/countries/:countryId/visa-requirements", limiter, getCountryVisaRequirements);

// Requirement Profiles endpoint
router.post("/requirement-profiles", limiter, createRequirementProfile);

// Document Management endpoints
router.get("/visa-cases/:visaCaseId/documents", limiter, getVisaCaseDocuments);
router.post("/visa-cases/:visaCaseId/documents", limiter, uploadVisaCaseDocument);
router.get("/documents/:documentId", limiter, getDocumentById);
router.patch("/documents/:documentId", limiter, updateDocumentMetadata);
router.delete("/documents/:documentId", limiter, archiveDocument);

// Document Verification Pipeline endpoints
router.post("/documents/:documentId/verification/start", limiter, startDocumentVerification);
router.get("/documents/:documentId/verification", limiter, getDocumentVerificationDetails);
router.post("/documents/:documentId/verification/manual-review", limiter, submitManualDocumentReview);
router.post("/documents/:documentId/verification/reverify", limiter, reverifyDocument);

// Embassy Processing & Batch Queue endpoints
router.post("/visa-cases/:visaCaseId/embassy-submissions", limiter, createEmbassySubmission);
router.get("/embassy-submissions/:submissionId", limiter, getEmbassySubmissionById);
router.patch("/embassy-submissions/:submissionId", limiter, updateEmbassySubmission);
router.post("/embassy-submissions/:submissionId/additional-documents", limiter, requestAdditionalDocuments);
router.post("/embassy-submissions/:submissionId/decision", limiter, registerEmbassyDecision);
router.post("/embassy-submissions/batches", limiter, createSubmissionBatch);

// Appointments & Biometrics Scheduling Engine endpoints
router.get("/visa-cases/:visaCaseId/appointments", limiter, getVisaCaseAppointments);
router.post("/visa-cases/:visaCaseId/appointments", limiter, scheduleVisaCaseAppointment);
router.patch("/appointments/:appointmentId", limiter, updateAppointment);
router.post("/appointments/:appointmentId/attendance", limiter, recordAppointmentAttendance);
router.post("/appointments/:appointmentId/result", limiter, recordAppointmentResult);

// Visa Workflow endpoints
router.get("/workflows/visa", limiter, getVisaWorkflowDefinition);
router.get("/visa-cases/:visaCaseId/workflow", limiter, getVisaCaseWorkflow);
router.post("/visa-cases/:visaCaseId/workflow/transition", limiter, transitionVisaCaseWorkflow);

// Passport Tracking Chain of Custody endpoints
router.get("/visa-cases/:visaCaseId/passport", limiter, getVisaCasePassport);
router.post("/visa-cases/:visaCaseId/passport/receive", limiter, receiveVisaCasePassport);
router.post("/passports/:passportId/transfer", limiter, transferPassportCustody);
router.post("/passports/:passportId/dispatch", limiter, dispatchPassportToEmbassy);
router.post("/passports/:passportId/receive-from-embassy", limiter, receivePassportFromEmbassy);
router.post("/passports/:passportId/collect", limiter, collectPassport);

// Incident Management endpoints for Visa Cases
router.get("/visa-cases/:visaCaseId/incidents", limiter, getVisaCaseIncidents);
router.post("/visa-cases/:visaCaseId/incidents", limiter, reportVisaCaseIncident);

// Notes & Timeline endpoints for Visa Cases
router.get("/visa-cases/:visaCaseId/timeline", authenticateAccessToken, limiter, getVisaCaseTimeline);
router.post("/visa-cases/:visaCaseId/notes", authenticateAccessToken, limiter, addVisaCaseNote);
router.get("/visa-cases/:visaCaseId/ai-context", authenticateAccessToken, limiter, getVisaCaseAIContext);
router.get("/timeline/:eventId", authenticateAccessToken, limiter, getTimelineEventById);

// Visa Case CRUD endpoints
router.get("/visa-cases", limiter, getVisaCases);
router.post("/visa-cases", limiter, createVisaCase);
router.get("/visa-cases/:visaCaseId", limiter, getVisaCaseById);
router.patch("/visa-cases/:visaCaseId", limiter, updateVisaCase);
router.delete("/visa-cases/:visaCaseId", limiter, deleteVisaCase);

export default router;
