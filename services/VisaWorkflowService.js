import { VISA_CASE_STATUSES, VISA_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import { publishEvent } from "../utils/eventBus.js";

class VisaWorkflowService {
  static getWorkflowDefinition(version = 1) {
    return {
      name: "Enterprise Visa Case Workflow",
      version,
      states: [
        { key: VISA_CASE_STATUSES.INQUIRY, label: "Inquiry", type: "initial" },
        { key: VISA_CASE_STATUSES.APPLICATION_DRAFT, label: "Draft", type: "active" },
        { key: VISA_CASE_STATUSES.REQUIREMENTS_GENERATED, label: "Requirements Generated", type: "active" },
        { key: VISA_CASE_STATUSES.DOCUMENTS_PENDING, label: "Documents Pending", type: "active" },
        { key: VISA_CASE_STATUSES.DOCUMENTS_UPLOADED, label: "Documents Uploaded", type: "active" },
        { key: VISA_CASE_STATUSES.DOCUMENTS_VERIFIED, label: "Documents Verified", type: "active" },
        { key: VISA_CASE_STATUSES.READY_FOR_SUBMISSION, label: "Ready For Submission", type: "active" },
        { key: VISA_CASE_STATUSES.SUBMITTED_TO_EMBASSY, label: "Submitted To Embassy", type: "active" },
        { key: VISA_CASE_STATUSES.EMBASSY_PROCESSING, label: "Embassy Processing", type: "active" },
        { key: VISA_CASE_STATUSES.INTERVIEW_REQUIRED, label: "Interview Required", type: "active" },
        { key: VISA_CASE_STATUSES.MEDICAL_REQUIRED, label: "Medical Required", type: "active" },
        { key: VISA_CASE_STATUSES.ADDITIONAL_DOCUMENTS_REQUIRED, label: "Additional Documents Required", type: "active" },
        { key: VISA_CASE_STATUSES.DECISION_RECEIVED, label: "Decision Received", type: "active" },
        { key: VISA_CASE_STATUSES.VISA_APPROVED, label: "Visa Approved", type: "active" },
        { key: VISA_CASE_STATUSES.PASSPORT_RETURNED, label: "Passport Returned", type: "active" },
        { key: VISA_CASE_STATUSES.COMPLETED, label: "Completed", type: "terminal" },
        { key: VISA_CASE_STATUSES.REJECTED, label: "Rejected", type: "terminal" },
        { key: VISA_CASE_STATUSES.CANCELLED, label: "Cancelled", type: "terminal" },
        { key: VISA_CASE_STATUSES.WITHDRAWN, label: "Withdrawn", type: "terminal" },
        { key: VISA_CASE_STATUSES.EXPIRED, label: "Expired", type: "terminal" },
        { key: VISA_CASE_STATUSES.BLACKLISTED, label: "Blacklisted", type: "terminal" },
        { key: VISA_CASE_STATUSES.APPEALED, label: "Appealed", type: "active" },
        { key: VISA_CASE_STATUSES.REOPENED, label: "Reopened", type: "active" }
      ],
      transitions: [
        { fromState: "inquiry", toState: "application_draft", action: "start_draft", requiredRole: "officer" },
        { fromState: "application_draft", toState: "requirements_generated", action: "generate_requirements", requiredRole: "officer" },
        { fromState: "requirements_generated", toState: "documents_pending", action: "request_documents", requiredRole: "officer" },
        { fromState: "documents_pending", toState: "documents_uploaded", action: "upload_documents", requiredRole: "officer" },
        { fromState: "documents_pending", toState: "documents_verified", action: "verify_documents", requiredRole: "officer" },
        { fromState: "documents_uploaded", toState: "documents_verified", action: "verify_documents", requiredRole: "officer" },
        { fromState: "documents_verified", toState: "ready_for_submission", action: "mark_ready", requiredRole: "officer" },
        { fromState: "ready_for_submission", toState: "submitted_to_embassy", action: "submit_to_embassy", requiredRole: "officer" },
        { fromState: "submitted_to_embassy", toState: "embassy_processing", action: "track_embassy", requiredRole: "officer" },
        { fromState: "embassy_processing", toState: "interview_required", action: "require_interview", requiredRole: "supervisor" },
        { fromState: "embassy_processing", toState: "medical_required", action: "require_medical", requiredRole: "supervisor" },
        { fromState: "embassy_processing", toState: "additional_documents_required", action: "request_more_docs", requiredRole: "officer" },
        { fromState: "embassy_processing", toState: "decision_received", action: "receive_decision", requiredRole: "officer" },
        { fromState: "embassy_processing", toState: "visa_approved", action: "approve_visa", requiredRole: "officer" },
        { fromState: "embassy_processing", toState: "rejected", action: "reject_visa", requiredRole: "officer" },
        { fromState: "decision_received", toState: "visa_approved", action: "approve_visa", requiredRole: "officer" },
        { fromState: "decision_received", toState: "rejected", action: "reject_visa", requiredRole: "officer" },
        { fromState: "interview_required", toState: "embassy_processing", action: "complete_interview", requiredRole: "officer" },
        { fromState: "medical_required", toState: "embassy_processing", action: "complete_medical", requiredRole: "officer" },
        { fromState: "additional_documents_required", toState: "embassy_processing", action: "submit_additional_docs", requiredRole: "officer" },
        { fromState: "visa_approved", toState: "passport_returned", action: "return_passport", requiredRole: "officer" },
        { fromState: "passport_returned", toState: "completed", action: "complete_case", requiredRole: "officer" },
        { fromState: "rejected", toState: "appealed", action: "appeal_case", requiredRole: "supervisor" },
        { fromState: "appealed", toState: "reopened", action: "reopen_case", requiredRole: "admin" },
        { fromState: "reopened", toState: "documents_pending", action: "restart_workflow", requiredRole: "admin" },
        { fromState: "documents_pending", toState: "cancelled", action: "cancel_case", requiredRole: "supervisor" },
        { fromState: "documents_verified", toState: "cancelled", action: "cancel_case", requiredRole: "supervisor" },
        { fromState: "ready_for_submission", toState: "cancelled", action: "cancel_case", requiredRole: "supervisor" }
      ],
      roles: ["officer", "supervisor", "admin", "country_specialist", "finance_approver"],
      actions: [
        "start_draft", "generate_requirements", "request_documents", "upload_documents",
        "verify_documents", "mark_ready", "submit_to_embassy", "track_embassy",
        "require_interview", "require_medical", "request_more_docs", "receive_decision",
        "approve_visa", "reject_visa", "return_passport", "complete_case",
        "appeal_case", "reopen_case", "restart_workflow", "cancel_case"
      ],
      slaRules: [
        { key: "document_upload_sla", name: "Document Upload SLA", hours: 24 },
        { key: "verification_sla", name: "Verification SLA", hours: 48 },
        { key: "submission_sla", name: "Submission SLA", hours: 72 },
        { key: "embassy_sla", name: "Embassy Processing SLA", hours: 168 },
        { key: "passport_return_sla", name: "Passport Return SLA", hours: 48 },
        { key: "escalation_sla", name: "Escalation SLA", hours: 12 }
      ],
      escalationChain: [
        { level: 1, role: "officer", name: "Officer Reminder" },
        { level: 2, role: "supervisor", name: "Supervisor Notification" },
        { level: 3, role: "branch_manager", name: "Branch Manager" },
        { level: 4, role: "operations_manager", name: "Operations Manager" },
        { level: 5, role: "executive", name: "Executive Dashboard" }
      ],
      approvalPolicies: [
        "Officer Approval",
        "Supervisor Approval",
        "Dual Approval",
        "Country Specialist Approval",
        "Finance Approval",
        "Administrator Approval"
      ],
      automationRules: [
        "Generate Timeline",
        "Create Audit",
        "Send Notifications",
        "Refresh Dashboard",
        "Update Search Index",
        "Schedule Appointment",
        "Create Tasks",
        "Trigger AI Analysis",
        "Generate Reports"
      ],
      status: "active"
    };
  }

  static evaluateTransition({ visaCase, targetState, userRoles = [] }) {
    const currentState = visaCase?.workflow?.currentStep || visaCase?.status || "inquiry";

    // Lock check for completed or blacklisted cases
    if (["completed", "blacklisted", "cancelled"].includes(currentState) && targetState !== "reopened" && targetState !== "appealed") {
      return {
        allowed: false,
        reasons: [`Workflow state '${currentState}' is locked and cannot be transitioned directly to '${targetState}'.`],
        transition: null
      };
    }

    const definition = this.getWorkflowDefinition(visaCase?.workflow?.version || 1);
    const allowedTransitions = definition.transitions.filter((t) => t.fromState === currentState);
    const transition = allowedTransitions.find((item) => item.toState === targetState);

    if (!transition) {
      return {
        allowed: false,
        reasons: [`Transition to '${targetState}' is not allowed from '${currentState}'.`],
        transition: null
      };
    }

    const reasons = [];

    // Guard Condition 1: Passport Validation
    if (!this.hasRequiredPassport(visaCase)) {
      reasons.push("Passport is missing or expired.");
    }

    // Guard Condition 2: Required Documents Verification
    if (["ready_for_submission", "submitted_to_embassy"].includes(targetState) && !this.hasVerifiedDocuments(visaCase)) {
      reasons.push("All required documents must be uploaded and verified before submission.");
    }

    // Guard Condition 3: Incident Blocking Check
    if (this.hasOpenIncidents(visaCase)) {
      reasons.push("Open incidents block workflow progression.");
    }

    // Guard Condition 4: User Role / Permission Validation
    if (!this.hasRequiredRole(userRoles, transition.requiredRole)) {
      reasons.push(`User lacks required role '${transition.requiredRole || "officer"}' for this transition.`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      transition
    };
  }

  static hasRequiredPassport(visaCase) {
    const passport = visaCase?.travelerSnapshot || {};
    const expiry = passport.passportExpiry ? new Date(passport.passportExpiry) : null;
    return Boolean(passport.passportNumber) && (!expiry || expiry > new Date());
  }

  static hasVerifiedDocuments(visaCase) {
    const requiredDocuments = Array.isArray(visaCase?.requiredDocuments) ? visaCase.requiredDocuments : [];
    if (requiredDocuments.length === 0) {
      return true;
    }

    return requiredDocuments.every((document) => {
      if (!document.isMandatory) {
        return true;
      }
      return document.status === "uploaded" || document.status === "verified";
    }) && requiredDocuments.every((document) => document.verificationStatus !== "failed");
  }

  static hasOpenIncidents(visaCase) {
    return Array.isArray(visaCase?.incidents) && visaCase.incidents.some((incident) => (incident.status || "").toLowerCase() === "open");
  }

  static hasRequiredRole(userRoles = [], requiredRole = "officer") {
    if (userRoles.includes("admin")) return true;
    if (!requiredRole) return userRoles.some((role) => ["officer", "supervisor", "admin"].includes(role));
    return userRoles.includes(requiredRole) || userRoles.includes("supervisor");
  }

  static async applyTransition({ visaCase, targetState, userRoles = [], performedBy = "system", remarks = null }) {
    const evaluation = this.evaluateTransition({ visaCase, targetState, userRoles });

    if (!evaluation.allowed) {
      publishEvent(VISA_DOMAIN_EVENTS.WORKFLOW_TRANSITION_REJECTED, {
        visaCaseId: visaCase._id?.toString?.() || visaCase.caseNumber,
        targetState,
        reasons: evaluation.reasons,
        performedBy
      });
      throw new Error(evaluation.reasons.join(" "));
    }

    const previousState = visaCase.workflow?.currentStep || visaCase.status || "inquiry";
    const nextState = targetState;

    visaCase.status = nextState;
    visaCase.workflow = {
      ...(visaCase.workflow || {}),
      currentStep: nextState,
      previousStep: previousState,
      completedSteps: Array.from(new Set([...(visaCase.workflow?.completedSteps || []), previousState, nextState]))
    };
    visaCase.timeline = Array.isArray(visaCase.timeline) ? visaCase.timeline : [];
    visaCase.timeline.push({
      event: VISA_DOMAIN_EVENTS.WORKFLOW_TRANSITION_COMPLETED,
      description: remarks || `Workflow transitioned from ${previousState} to ${nextState}`,
      statusFrom: previousState,
      statusTo: nextState,
      performedBy,
      timestamp: new Date()
    });

    publishEvent(VISA_DOMAIN_EVENTS.WORKFLOW_TRANSITION_COMPLETED, {
      visaCaseId: visaCase._id?.toString?.() || visaCase.caseNumber,
      previousState,
      currentState: nextState,
      performedBy,
      remarks
    });

    if (nextState === VISA_CASE_STATUSES.COMPLETED) {
      publishEvent(VISA_DOMAIN_EVENTS.WORKFLOW_COMPLETED, {
        visaCaseId: visaCase._id?.toString?.() || visaCase.caseNumber,
        performedBy
      });
    }

    return {
      previousState,
      currentState: nextState,
      transition: evaluation.transition,
      timelineEntry: visaCase.timeline.at(-1)
    };
  }
}

export default VisaWorkflowService;

