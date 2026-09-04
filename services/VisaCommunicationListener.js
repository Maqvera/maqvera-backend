import { subscribeEvent } from "../utils/eventBus.js";
import CommunicationPlatformService from "./CommunicationPlatformService.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import EmbassySubmissionModel from "../models/EmbassySubmissionModel.js";
import { VISA_CASE_STATUSES, VISA_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import logger from "../utils/logger.js";

/**
 * Visa Module PRD §16 "WhatsApp Templates" — real send via the existing
 * Enterprise Communication Platform (CommunicationPlatformService.
 * requestCommunication, channel "WhatsApp") and its real Twilio-backed
 * WhatsAppDeliveryAdapter (services/delivery/WhatsAppDeliveryAdapter.js) —
 * the same adapter services/SchedulingEngineService.js already schedules
 * appointment reminders through. Every domain event this subscribes to
 * already fires today (see each handler's own doc comment for its exact
 * source); this was purely a "event exists, nobody listens" gap, the same
 * class of gap Visa Module PRD §13/§2 (Accounts Integration) closed.
 *
 * Every handler is best-effort: a missing template (tenant hasn't run
 * `npm run seed:visa-communication-templates`), a traveler with no phone on
 * file, or a delivery failure is logged and swallowed — never allowed to
 * block the visa case action that already genuinely happened, same contract
 * as every other event-bus listener in this codebase.
 */
class VisaCommunicationListener {
  static _initialized = false;

  static initEventListeners() {
    if (VisaCommunicationListener._initialized) return;
    VisaCommunicationListener._initialized = true;

    // "Documents Required" — fires once a case's requirement profile is
    // resolved (VisaService.createVisaCase), the real moment the traveler
    // has something to upload.
    subscribeEvent("RequirementsGenerated", (payload) => VisaCommunicationListener._handleDocumentsRequired(payload));
    // "Documents Missing" — DocumentVerificationService already publishes
    // this on manual-review rejection (services/DocumentVerificationService.js).
    subscribeEvent("DocumentRejected", (payload) => VisaCommunicationListener._handleDocumentsMissing(payload));
    // "Application Submitted" — EmbassyProcessingService.createEmbassySubmission.
    subscribeEvent("EmbassySubmissionCreated", (payload) => VisaCommunicationListener._handleApplicationSubmitted(payload));
    // "Processing" / "Approved" / "Rejected" — VISA_APPROVED/VISA_REJECTED
    // are declared in VISA_DOMAIN_EVENTS but never actually published
    // anywhere in this codebase (confirmed by trace); WORKFLOW_TRANSITION_COMPLETED
    // is the one real, always-fired hook every state change goes through
    // (VisaWorkflowService.transitionWorkflow), so status is read off its
    // own currentState payload instead.
    subscribeEvent(VISA_DOMAIN_EVENTS.WORKFLOW_TRANSITION_COMPLETED, (payload) => VisaCommunicationListener._handleWorkflowTransition(payload));
  }

  static async _resolveTraveler(visaCaseId, tenantId) {
    const visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId }).lean();
    if (!visaCase?.travelerSnapshot?.phone) return null;
    return { visaCase, phone: visaCase.travelerSnapshot.phone, name: visaCase.travelerSnapshot.fullName || "there" };
  }

  static async _send(templateId, tenantId, phone, templateData) {
    await CommunicationPlatformService.requestCommunication({
      tenantId,
      sourceModule: "Visa",
      channel: "WhatsApp",
      recipient: { phone },
      templateId,
      templateData,
      priority: "Normal"
    });
  }

  static async _handleDocumentsRequired({ visaCaseId, tenantId }) {
    if (!visaCaseId || !tenantId) return;
    try {
      const resolved = await VisaCommunicationListener._resolveTraveler(visaCaseId, tenantId);
      if (!resolved) return;
      await VisaCommunicationListener._send("visa.documents_required", tenantId, resolved.phone, {
        travelerName: resolved.name, visaType: resolved.visaCase.visaType,
        destinationCountry: resolved.visaCase.destinationCountry, caseNumber: resolved.visaCase.caseNumber
      });
    } catch (error) {
      logger.error(`VisaCommunicationListener: documents_required failed for case ${visaCaseId}: ${error.message}`, { tenantId, visaCaseId });
    }
  }

  static async _handleDocumentsMissing({ visaCaseId, tenantId, reason }) {
    if (!visaCaseId || !tenantId) return;
    try {
      const resolved = await VisaCommunicationListener._resolveTraveler(visaCaseId, tenantId);
      if (!resolved) return;
      await VisaCommunicationListener._send("visa.documents_missing", tenantId, resolved.phone, {
        travelerName: resolved.name, reason: reason || "Please review your document.", caseNumber: resolved.visaCase.caseNumber
      });
    } catch (error) {
      logger.error(`VisaCommunicationListener: documents_missing failed for case ${visaCaseId}: ${error.message}`, { tenantId, visaCaseId });
    }
  }

  static async _handleApplicationSubmitted({ visaCaseId, tenantId, submissionId }) {
    if (!visaCaseId || !tenantId) return;
    try {
      const resolved = await VisaCommunicationListener._resolveTraveler(visaCaseId, tenantId);
      if (!resolved) return;
      const submission = submissionId ? await EmbassySubmissionModel.findOne({ _id: submissionId, tenantId }).lean() : null;
      await VisaCommunicationListener._send("visa.application_submitted", tenantId, resolved.phone, {
        travelerName: resolved.name, caseNumber: resolved.visaCase.caseNumber,
        embassyName: submission?.embassyName || "the embassy", expectedProcessingDays: submission?.expectedProcessingDays ?? "a few"
      });
    } catch (error) {
      logger.error(`VisaCommunicationListener: application_submitted failed for case ${visaCaseId}: ${error.message}`, { tenantId, visaCaseId });
    }
  }

  static async _handleWorkflowTransition({ visaCaseId, tenantId, currentState }) {
    if (!visaCaseId || !tenantId) return;
    const templateByState = {
      [VISA_CASE_STATUSES.EMBASSY_PROCESSING]: "visa.processing",
      [VISA_CASE_STATUSES.VISA_APPROVED]: "visa.approved",
      [VISA_CASE_STATUSES.REJECTED]: "visa.rejected"
    };
    const templateId = templateByState[currentState];
    if (!templateId) return;

    try {
      const resolved = await VisaCommunicationListener._resolveTraveler(visaCaseId, tenantId);
      if (!resolved) return;
      const templateData = {
        travelerName: resolved.name, caseNumber: resolved.visaCase.caseNumber,
        destinationCountry: resolved.visaCase.destinationCountry,
        rejectionReason: resolved.visaCase.decision?.rejectionReason || "not specified"
      };
      await VisaCommunicationListener._send(templateId, tenantId, resolved.phone, templateData);
    } catch (error) {
      logger.error(`VisaCommunicationListener: ${templateId} failed for case ${visaCaseId}: ${error.message}`, { tenantId, visaCaseId });
    }
  }
}

export default VisaCommunicationListener;
