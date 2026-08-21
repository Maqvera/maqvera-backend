export const VISA_CASE_STATUSES = {
  INQUIRY: "inquiry",
  ELIGIBILITY_CHECK: "eligibility_check",
  APPLICATION_DRAFT: "application_draft",
  REQUIREMENTS_GENERATED: "requirements_generated",
  DOCUMENTS_PENDING: "documents_pending",
  DOCUMENTS_UPLOADED: "documents_uploaded",
  DOCUMENTS_VERIFIED: "documents_verified",
  READY_FOR_SUBMISSION: "ready_for_submission",
  SUBMITTED_TO_EMBASSY: "submitted_to_embassy",
  EMBASSY_PROCESSING: "embassy_processing",
  INTERVIEW_REQUIRED: "interview_required",
  INTERVIEW_SCHEDULED: "interview_scheduled",
  MEDICAL_REQUIRED: "medical_required",
  MEDICAL_SCHEDULED: "medical_scheduled",
  ADDITIONAL_DOCUMENTS_REQUIRED: "additional_documents_required",
  DECISION_RECEIVED: "decision_received",
  VISA_APPROVED: "visa_approved",
  VISA_PRINTED: "visa_printed",
  PASSPORT_RETURNED: "passport_returned",
  PASSPORT_COLLECTED: "passport_collected",
  TRAVEL_READY: "travel_ready",
  COMPLETED: "completed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  WITHDRAWN: "withdrawn",
  BLACKLISTED: "blacklisted",
  APPEALED: "appealed",
  REOPENED: "reopened"
};

export const VISA_TYPES = {
  TOURIST: "tourist_visa",
  BUSINESS: "business_visa",
  VISIT: "visit_visa",
  UMRAH: "umrah_visa",
  HAJJ: "hajj_visa",
  WORK: "work_visa",
  STUDENT: "student_visa",
  MEDICAL: "medical_visa",
  TRANSIT: "transit_visa",
  FAMILY: "family_visa",
  DIPLOMATIC: "diplomatic_visa",
  CUSTOM: "custom"
};

export const VISA_DOMAIN_EVENTS = {
  VISA_CASE_CREATED: "VisaCaseCreated",
  VISA_APPLICATION_CREATED: "VisaApplicationCreated",
  DOCUMENT_UPLOADED: "DocumentUploaded",
  DOCUMENT_VERIFIED: "DocumentVerified",
  EMBASSY_SUBMISSION_CREATED: "EmbassySubmissionCreated",
  APPOINTMENT_SCHEDULED: "AppointmentScheduled",
  INTERVIEW_COMPLETED: "InterviewCompleted",
  MEDICAL_COMPLETED: "MedicalCompleted",
  VISA_APPROVED: "VisaApproved",
  VISA_REJECTED: "VisaRejected",
  PASSPORT_COLLECTED: "PassportCollected",
  VISA_COMPLETED: "VisaCompleted",
  WORKFLOW_STARTED: "WorkflowStarted",
  WORKFLOW_TRANSITION_REQUESTED: "WorkflowTransitionRequested",
  WORKFLOW_TRANSITION_COMPLETED: "WorkflowTransitionCompleted",
  WORKFLOW_TRANSITION_REJECTED: "WorkflowTransitionRejected",
  WORKFLOW_COMPLETED: "WorkflowCompleted",
  WORKFLOW_REOPENED: "WorkflowReopened",
  WORKFLOW_ESCALATED: "WorkflowEscalated",
  WORKFLOW_CANCELLED: "WorkflowCancelled",
  SLA_BREACHED: "SLABreached",
  APPROVAL_COMPLETED: "ApprovalCompleted",
  // Visa Module PRD §13 "Accounts Integration" — fired once an application's
  // sellingPrice is first set to a non-zero value, so VisaFinanceLinkService
  // (Part 2 of the Visa gap-closing work) can post the matching Invoice +
  // AccountsReceivable row automatically.
  VISA_CASE_INVOICED: "VisaCaseInvoiced"
};

// Visa Module PRD §15 "Refunds: Refund Reason (e.g. Visa Rejected, Customer
// Cancellation)" — used to restrict the visa-scoped refund convenience
// endpoint (VisaController.createVisaCaseRefund) to real, expected reasons,
// same config-driven-domain-values discipline as utils/bookingConfig.js.
export const VISA_REFUND_REASONS = ["Visa Rejected", "Customer Cancellation", "Duplicate Payment", "Service Not Rendered", "Other"];

export const PASSPORT_STATUSES = {
  RECEIVED: "Received",
  UNDER_VERIFICATION: "Under Verification",
  READY_FOR_DISPATCH: "Ready For Dispatch",
  DISPATCHED: "Dispatched",
  WITH_COURIER: "With Courier",
  AT_EMBASSY: "At Embassy",
  EMBASSY_PROCESSING: "Embassy Processing",
  RETURNED: "Returned",
  READY_FOR_COLLECTION: "Ready For Collection",
  COLLECTED: "Collected",
  LOST: "Lost",
  DAMAGED: "Damaged",
  CANCELLED: "Cancelled"
};

export const PASSPORT_DOMAIN_EVENTS = {
  PASSPORT_RECEIVED: "PassportReceived",
  PASSPORT_TRANSFERRED: "PassportTransferred",
  PASSPORT_DISPATCHED: "PassportDispatched",
  PASSPORT_DELIVERED: "PassportDelivered",
  PASSPORT_RETURNED: "PassportReturned",
  PASSPORT_COLLECTED: "PassportCollected",
  PASSPORT_LOST: "PassportLost",
  PASSPORT_DAMAGED: "PassportDamaged",
  PASSPORT_CUSTODY_CHANGED: "PassportCustodyChanged",
  PASSPORT_TRACKING_UPDATED: "PassportTrackingUpdated"
};


