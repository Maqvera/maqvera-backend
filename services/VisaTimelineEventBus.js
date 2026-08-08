import VisaCaseModel from "../models/VisaCaseModel.js";
import { subscribeEvent } from "../utils/eventBus.js";
import EnterpriseTimelineEngineService from "./EnterpriseTimelineEngineService.js";

// A single mapping keeps every Visa producer consistent while allowing new
// modules to publish normal domain events without importing timeline storage.
const EVENT_DEFINITIONS = {
  VisaCaseCreated: ["VisaManagement", "CaseCreated", "Visa case created"],
  VisaApplicationCreated: ["VisaManagement", "ApplicationCreated", "Visa application initialized"],
  VisaApplicationInitialized: ["VisaManagement", "ApplicationCreated", "Visa application initialized"],
  RequirementsGenerated: ["Requirements", "RequirementsGenerated", "Visa requirements generated"],
  VisaCaseUpdated: ["VisaManagement", "CaseUpdated", "Visa case updated"],
  WorkflowTransitionCompleted: ["Workflow", "StatusChanged", "Visa workflow status changed"],
  DocumentUploaded: ["Documents", "DocumentUploaded", "Document uploaded"],
  VerificationApproved: ["Verification", "DocumentVerified", "Document verified"],
  VerificationRejected: ["Verification", "DocumentRejected", "Document rejected"],
  EmbassySubmissionCreated: ["Embassy", "EmbassySubmitted", "Embassy submission created"],
  VisaDecisionReceived: ["Embassy", "EmbassyResponse", "Embassy decision received"],
  AppointmentScheduled: ["Appointments", "AppointmentScheduled", "Appointment scheduled"],
  AppointmentCompleted: ["Appointments", "AppointmentCompleted", "Appointment completed"],
  PassportReceived: ["PassportTracking", "PassportReceived", "Passport received"],
  PassportDispatched: ["PassportTracking", "PassportDispatched", "Passport dispatched"],
  PassportReturned: ["PassportTracking", "PassportReturned", "Passport returned"],
  PassportCollected: ["PassportTracking", "PassportCollected", "Passport collected"],
  IncidentCreated: ["Incidents", "IncidentCreated", "Incident created"],
  IncidentResolved: ["Incidents", "IncidentResolved", "Incident resolved"]
};

class VisaTimelineEventBus {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    for (const [domainEvent, [sourceModule, eventType, title]] of Object.entries(EVENT_DEFINITIONS)) {
      subscribeEvent(domainEvent, async (payload) => {
        if (!payload?.visaCaseId || !payload?.tenantId) return;
        const visaCase = await VisaCaseModel.findOne({ _id: payload.visaCaseId, tenantId: payload.tenantId }).catch(() => null);
        if (!visaCase) return;

        await EnterpriseTimelineEngineService.recordEvent({
          tenantId: payload.tenantId,
          visaCaseId: visaCase._id,
          visaCase,
          sourceModule,
          aggregateType: "VisaCase",
          aggregateId: visaCase._id.toString(),
          eventType,
          title,
          description: payload.description || title,
          actor: { userId: payload.userId || payload.updatedBy || "system", name: payload.userName || "System", role: payload.role || "System" },
          correlationId: payload.correlationId || `CORR-VISA-${visaCase._id}`,
          metadata: { domainEvent, relatedEntityId: payload.documentId || payload.submissionId || payload.appointmentId || payload.incidentId || null }
        });
      });
    }
  }
}

export default VisaTimelineEventBus;
