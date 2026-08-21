import VisaCaseModel from "../models/VisaCaseModel.js";
import InvoiceService from "./InvoiceService.js";
import AccountsPayableService from "./AccountsPayableService.js";
import { subscribeEvent } from "../utils/eventBus.js";
import { VISA_DOMAIN_EVENTS } from "../utils/visaConstants.js";
import logger from "../utils/logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Visa <-> Finance bridge (Visa Module PRD §13 "Accounts Integration", the
 * PRD's own "Important" gap). Mirrors BookingFinanceLinkService's shape
 * exactly: Visa creates no Finance records directly — per CLAUDE.md,
 * cross-context communication goes through the event bus — so this listens
 * for events VisaService/EmbassyProcessingService already publish and drives
 * the real Invoice -> AccountsReceivable machinery on the customer side, and
 * AccountsPayableService on the vendor side, instead of leaving payments to
 * be manually, duplicatively entered against the generic Finance endpoints
 * (exactly what the PRD says must not happen).
 *
 * Every handler here is best-effort: a Finance-side failure is logged and
 * swallowed, never allowed to undo or block the visa case action that
 * already genuinely happened — same contract as every other event-bus
 * listener in this codebase (utils/eventBus.js already isolates listener
 * failures via Promise.allSettled).
 */
class VisaFinanceLinkService {
  static _initialized = false;

  static initEventListeners() {
    if (VisaFinanceLinkService._initialized) return;
    VisaFinanceLinkService._initialized = true;

    subscribeEvent(VISA_DOMAIN_EVENTS.VISA_CASE_INVOICED, (payload) => VisaFinanceLinkService._handleVisaCaseInvoiced(payload));
    subscribeEvent("EmbassySubmissionCreated", (payload) => VisaFinanceLinkService._handleEmbassySubmissionCreated(payload));
  }

  /**
   * Issues a real Invoice (Draft -> Approved -> Issued) for the priced
   * application's sellingPrice, which — via InvoiceService.issueInvoice's
   * own InvoiceCreated publish — triggers AccountsReceivableService's
   * listener to create the matching Receivable (same chain
   * BookingFinanceLinkService already relies on). The resulting
   * invoiceId/invoiceNumber is written back onto the specific application so
   * CustomerAccountStatementService's existing AccountsReceivableModel-based
   * read picks it up automatically, with no changes needed there.
   *
   * Idempotency: guarded on application.invoiceId already being set (an
   * explicit check, not just "this event only fires once" — the event is
   * itself already emitted only on the 0->positive sellingPrice transition,
   * see VisaService.updateApplicationPricing, but a second guard here means
   * this handler is safe even if that event is ever re-published for any
   * reason, matching the Definition of Done's idempotency requirement).
   */
  static async _handleVisaCaseInvoiced({ visaCaseId, tenantId, applicationNumber, sellingPrice, currency, travelerId }) {
    if (!visaCaseId || !tenantId || !applicationNumber) return;
    try {
      const visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId });
      if (!visaCase) return;

      const application = visaCase.applications.find((app) => app.applicationNumber === applicationNumber);
      if (!application) return;
      if (application.invoiceId) return; // already invoiced — never issue a second one

      const amount = application.sellingPrice || sellingPrice || 0;
      if (amount <= 0) return; // nothing to bill

      const customerId = travelerId || visaCase.travelerId;
      if (!customerId) return;

      const issueDate = new Date();
      const dueDate = visaCase.plannedTravelDate && visaCase.plannedTravelDate.getTime() > issueDate.getTime()
        ? visaCase.plannedTravelDate
        : new Date(issueDate.getTime() + 7 * MS_PER_DAY);

      const invoice = await InvoiceService.createInvoice({
        customerId,
        visaCaseId: visaCase._id,
        currency: application.currency || currency || "USD",
        issueDate,
        dueDate,
        items: [{ description: `Visa Application ${applicationNumber} (Case ${visaCase.caseNumber})`, quantity: 1, unitPrice: amount }],
        notes: `Auto-generated for visa case ${visaCase.caseNumber}, application ${applicationNumber}.`
      }, tenantId, "system");

      await InvoiceService.approveInvoice(invoice._id, tenantId, "system");
      const issued = await InvoiceService.issueInvoice(invoice._id, tenantId, "system");

      await VisaCaseModel.updateOne(
        { _id: visaCaseId, tenantId, "applications.applicationNumber": applicationNumber },
        { $set: { "applications.$.invoiceId": issued._id, "applications.$.invoiceNumber": issued.invoiceNumber } }
      );

      logger.info(`Visa case ${visaCase.caseNumber} application ${applicationNumber} linked to invoice ${issued.invoiceNumber}.`, { tenantId, visaCaseId });
    } catch (error) {
      logger.error(`VisaFinanceLinkService: failed to create invoice for visa case ${visaCaseId} application ${applicationNumber}: ${error.message}`, { tenantId, visaCaseId });
    }
  }

  /**
   * Posts a real AccountsPayable row for the vendor cost of the case's
   * priced application, once that case is actually submitted to a vendor
   * (embassySubmissions[] entry created with a vendorId). Only fires when
   * both a vendor and a positive vendorCost exist — a submission with no
   * third-party vendor involved, or an application never priced on the
   * vendor-cost side, has nothing payable to post.
   *
   * Idempotency: guarded on application.payableId already being set, same
   * pattern as the invoice side above.
   */
  static async _handleEmbassySubmissionCreated({ visaCaseId, tenantId, vendorId }) {
    if (!visaCaseId || !tenantId || !vendorId) return; // no vendor involved — nothing payable
    try {
      const visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId });
      if (!visaCase) return;

      // Multiple applications can exist on one case; the one actually being
      // submitted is whichever has a vendor cost set and isn't payable yet —
      // the same "priced but not yet posted" signal the invoice side uses.
      const application = visaCase.applications.find((app) => (app.vendorCost || 0) > 0 && !app.payableId);
      if (!application) return;

      const payable = await AccountsPayableService.createPayable({
        vendorId,
        dueDate: new Date(Date.now() + 30 * MS_PER_DAY),
        originalAmount: application.vendorCost,
        currency: application.currency || "USD"
      }, tenantId, "system");

      await VisaCaseModel.updateOne(
        { _id: visaCaseId, tenantId, "applications.applicationNumber": application.applicationNumber },
        { $set: { "applications.$.payableId": payable._id } }
      );

      logger.info(`Visa case ${visaCase.caseNumber} application ${application.applicationNumber} linked to payable ${payable._id}.`, { tenantId, visaCaseId, vendorId });
    } catch (error) {
      logger.error(`VisaFinanceLinkService: failed to create payable for visa case ${visaCaseId}: ${error.message}`, { tenantId, visaCaseId, vendorId });
    }
  }
}

export default VisaFinanceLinkService;
