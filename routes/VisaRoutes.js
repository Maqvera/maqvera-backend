import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { upload } from "../services/FileUploadService.js";
import {
  getVisaCases,
  createVisaCase,
  getVisaCaseById,
  updateVisaCase,
  deleteVisaCase,
  getVisaTypes,
  createVisaType,
  updateVisaType,
  updateVisaCaseApplicationPricing,
  listCountries,
  createCountry,
  updateCountry,
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
  reportPassportLostOrDamaged,
  getVisaCaseIncidents,
  reportVisaCaseIncident,
  getVisaCaseTimeline,
  addVisaCaseNote,
  getVisaCaseAIContext,
  getTimelineEventById,
  getVisaCasePayments,
  createVisaCaseRefund
} from "../controllers/VisaController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
});

// Security note: only genuinely tenant-agnostic catalog/reference reads stay
// public — visa types, country requirement rules, and the static/default
// workflow definition (none of these touch a specific tenant's customer
// data). Visa CASE reads were previously also public and are NOT anymore:
// visa cases carry customer PII (passport numbers, traveler details) and are
// tenant-owned, so a public "visa-case reads" contract was itself a bug, not
// an intentional exception — see getVisaCases/getVisaCaseById below. Every
// write and every other nested-resource read requires authenticateAccessToken;
// this file previously had no router.use(authenticateAccessToken) and most
// routes had no inline auth either, meaning documents (passport scans),
// embassy decisions, passport custody transfers, and the case CRUD writes
// themselves were reachable by anyone who could reach the API, tenant-scoped
// only by a client-supplied x-tenant-id header. Each route below is explicit
// about its own auth requirement rather than relying on file-level defaults.

// Visa Types Catalog endpoint (public — static, tenant-agnostic catalog)
router.get("/visa-types", limiter, getVisaTypes);
// Visa Types admin pricing endpoints (write — creates/updates tenant pricing config)
router.post("/visa-types", authenticateAccessToken, limiter, createVisaType);
router.patch("/visa-types/:visaTypeId", authenticateAccessToken, limiter, updateVisaType);

// Visa Case Application Pricing endpoint (write — PRD §8/§12)
router.patch("/visa-cases/:visaCaseId/applications/:applicationNumber/pricing", authenticateAccessToken, limiter, updateVisaCaseApplicationPricing);

// Country Master endpoints (PRD §7). List is public reference data, matching
// visa-types above; write endpoints require auth. Registered before the
// dynamic "/countries/:countryId/visa-requirements" GET below — same
// static-before-dynamic convention used elsewhere (routes/FinanceRoutes.js).
router.get("/countries", limiter, listCountries);
router.post("/countries", authenticateAccessToken, limiter, createCountry);
router.patch("/countries/:countryMasterId", authenticateAccessToken, limiter, updateCountry);

// Country Visa Requirements Rule Engine endpoint (public — reference data)
router.get("/countries/:countryId/visa-requirements", limiter, getCountryVisaRequirements);

// Requirement Profiles endpoint (write — creates configuration data)
router.post("/requirement-profiles", authenticateAccessToken, limiter, createRequirementProfile);

// Document Management endpoints
router.get("/visa-cases/:visaCaseId/documents", authenticateAccessToken, limiter, getVisaCaseDocuments);
router.post("/visa-cases/:visaCaseId/documents", authenticateAccessToken, limiter, upload.single("file"), uploadVisaCaseDocument);
router.get("/documents/:documentId", authenticateAccessToken, limiter, getDocumentById);
router.patch("/documents/:documentId", authenticateAccessToken, limiter, updateDocumentMetadata);
router.delete("/documents/:documentId", authenticateAccessToken, limiter, archiveDocument);

// Document Verification Pipeline endpoints
router.post("/documents/:documentId/verification/start", authenticateAccessToken, limiter, startDocumentVerification);
router.get("/documents/:documentId/verification", authenticateAccessToken, limiter, getDocumentVerificationDetails);
router.post("/documents/:documentId/verification/manual-review", authenticateAccessToken, limiter, submitManualDocumentReview);
router.post("/documents/:documentId/verification/reverify", authenticateAccessToken, limiter, reverifyDocument);

// Embassy Processing & Batch Queue endpoints
router.post("/visa-cases/:visaCaseId/embassy-submissions", authenticateAccessToken, limiter, createEmbassySubmission);
router.get("/embassy-submissions/:submissionId", authenticateAccessToken, limiter, getEmbassySubmissionById);
router.patch("/embassy-submissions/:submissionId", authenticateAccessToken, limiter, updateEmbassySubmission);
router.post("/embassy-submissions/:submissionId/additional-documents", authenticateAccessToken, limiter, requestAdditionalDocuments);
router.post("/embassy-submissions/:submissionId/decision", authenticateAccessToken, limiter, registerEmbassyDecision);
router.post("/embassy-submissions/batches", authenticateAccessToken, limiter, createSubmissionBatch);

// Appointments & Biometrics Scheduling Engine endpoints
router.get("/visa-cases/:visaCaseId/appointments", authenticateAccessToken, limiter, getVisaCaseAppointments);
router.post("/visa-cases/:visaCaseId/appointments", authenticateAccessToken, limiter, scheduleVisaCaseAppointment);
router.patch("/appointments/:appointmentId", authenticateAccessToken, limiter, updateAppointment);
router.post("/appointments/:appointmentId/attendance", authenticateAccessToken, limiter, recordAppointmentAttendance);
router.post("/appointments/:appointmentId/result", authenticateAccessToken, limiter, recordAppointmentResult);

// Visa Workflow endpoints
router.get("/workflows/visa", limiter, getVisaWorkflowDefinition);
router.get("/visa-cases/:visaCaseId/workflow", authenticateAccessToken, limiter, getVisaCaseWorkflow);
router.post("/visa-cases/:visaCaseId/workflow/transition", authenticateAccessToken, limiter, transitionVisaCaseWorkflow);

// Passport Tracking Chain of Custody endpoints
router.get("/visa-cases/:visaCaseId/passport", authenticateAccessToken, limiter, getVisaCasePassport);
router.post("/visa-cases/:visaCaseId/passport/receive", authenticateAccessToken, limiter, receiveVisaCasePassport);
router.post("/passports/:passportId/transfer", authenticateAccessToken, limiter, transferPassportCustody);
router.post("/passports/:passportId/dispatch", authenticateAccessToken, limiter, dispatchPassportToEmbassy);
router.post("/passports/:passportId/receive-from-embassy", authenticateAccessToken, limiter, receivePassportFromEmbassy);
router.post("/passports/:passportId/collect", authenticateAccessToken, limiter, collectPassport);
router.post("/passports/:passportId/report-lost", authenticateAccessToken, limiter, reportPassportLostOrDamaged);

// Incident Management endpoints for Visa Cases
router.get("/visa-cases/:visaCaseId/incidents", authenticateAccessToken, limiter, getVisaCaseIncidents);
router.post("/visa-cases/:visaCaseId/incidents", authenticateAccessToken, limiter, reportVisaCaseIncident);

// Notes & Timeline endpoints for Visa Cases
router.get("/visa-cases/:visaCaseId/timeline", authenticateAccessToken, limiter, getVisaCaseTimeline);
router.post("/visa-cases/:visaCaseId/notes", authenticateAccessToken, limiter, addVisaCaseNote);
router.get("/visa-cases/:visaCaseId/ai-context", authenticateAccessToken, limiter, getVisaCaseAIContext);
router.get("/timeline/:eventId", authenticateAccessToken, limiter, getTimelineEventById);

// Visa-scoped Payment/Refund convenience endpoints (PRD §14/§15) — thin
// wrappers over the generic Finance Payment/Refund engines, not a parallel
// payment system.
router.get("/visa-cases/:visaCaseId/payments", authenticateAccessToken, limiter, getVisaCasePayments);
router.post("/visa-cases/:visaCaseId/refunds", authenticateAccessToken, limiter, createVisaCaseRefund);

// Visa Case CRUD endpoints. GET (list/detail) were previously public — but
// visa cases carry customer PII (passport numbers, traveler details) and are
// tenant-owned, and the "public" implementation trusted a client-supplied
// x-tenant-id header for tenant identity: anyone could read any tenant's
// complete visa case list/detail with zero authentication just by setting
// that header. Both now require auth, same as every other tenant-owned read
// in this file.
router.get("/visa-cases", authenticateAccessToken, limiter, getVisaCases);
router.post("/visa-cases", authenticateAccessToken, limiter, createVisaCase);
router.get("/visa-cases/:visaCaseId", authenticateAccessToken, limiter, getVisaCaseById);
router.patch("/visa-cases/:visaCaseId", authenticateAccessToken, limiter, updateVisaCase);
router.delete("/visa-cases/:visaCaseId", authenticateAccessToken, limiter, deleteVisaCase);

export default router;
