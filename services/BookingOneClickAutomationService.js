import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CustomerModel from "../models/CustomerModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import BookingAutomationRunModel from "../models/BookingAutomationRunModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import VisaService from "./VisaService.js";
import WhatsAppPlatformService from "./WhatsAppPlatformService.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import { GenerateBookingInvoice } from "../controllers/BookingController.js";
import { publishEvent } from "../utils/eventBus.js";

// One-Click Automation Engine (PRD "CRM Feature Map by Phase" Phase 3
// module 22) — investigated before writing a line of this: the PRD's full
// six-step chain (hotel allocation, flight booking, visa case, invoice,
// WhatsApp confirmation, payment reminders) is NOT uniformly safe to
// automate today. Deliberately scoped down to the three steps that are
// (a) fully self-contained with real, already-built services underneath,
// and (b) genuinely independent/additive — none of the three needs to be
// undone if another fails, so this needs no compensation/rollback engine:
//
//   - create_visa_case: VisaService.createVisaCase — real, reusable as-is.
//   - generate_invoice: BookingController.GenerateBookingInvoice — same
//     controller a staff member would call by hand, reused directly (via
//     the same fakeReq/fakeRes pattern LeadService.convertToCustomer and
//     PublicBookingService already use), never re-implemented.
//   - send_whatsapp_confirmation: composed directly from
//     WhatsAppPlatformService.sendWhatsApp (no prebuilt "send booking
//     confirmation" helper existed).
//
// Explicitly NOT included, and NOT silently faked:
//   - Hotel room allocation — convertPackageToBooking only creates a
//     BookingServiceModel hotel line; real allocation
//     (TravelHotelController.AllocateRooms) needs a TravelPlanModel +
//     TravelHotelAssignmentModel that don't exist yet for a
//     package-originated booking. Bridging that is real new design
//     surface (how does a generic service line map to a room assignment?),
//     not composition — out of scope here per product decision.
//   - Flight booking — CreateAmadeusFlightBooking requires a live Amadeus
//     offer object from a prior human search/selection; there is no safe
//     way to "one-click" select a real flight on a customer's behalf.
//   - Payment reminder scheduling — no due-date field exists anywhere on
//     PaymentModel/BookingHeaderModel to schedule a reminder against.
//
// Every run is persisted to BookingAutomationRunModel (one row per call,
// full per-step detail) so a repeat call is provably idempotent — each
// step independently detects and skips (never re-does) work a prior run
// already completed.
class BookingOneClickAutomationService {
  /**
   * @param {string} bookingId
   * @param {object} options - { visa?: {countryId|destinationCountry, visaTypeId|visaType, travelPurpose?, priority?}, invoice?: {dueDate?}, whatsapp?: {templateId?} }
   */
  static async run(bookingId, options = {}, tenantId, userId, requestId) {
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) throw new Error("Booking not found.");

    const steps = [];

    // ---- Visa case: opt-in only. Destination/visa-type are never guessed
    // from the booking — the booking's own hotel/flight/visa service lines
    // don't carry that data forward from the package that created them, so
    // fabricating it here would risk filing the wrong visa. ----
    if (options.visa) {
      steps.push(await runStep("create_visa_case", async () => {
        try {
          const visaCase = await VisaService.createVisaCase({
            travelerId: booking.customerId.toString(),
            countryId: options.visa.countryId || undefined,
            destinationCountry: options.visa.destinationCountry || undefined,
            visaTypeId: options.visa.visaTypeId || undefined,
            visaType: options.visa.visaType || undefined,
            travelPurpose: options.visa.travelPurpose || "Tourism",
            plannedTravelDate: booking.travelDate || null,
            priority: options.visa.priority || "normal"
          }, tenantId, userId);
          return { skipped: false, caseNumber: visaCase.caseNumber, visaCaseId: visaCase._id };
        } catch (error) {
          if (error.message.includes("already exists")) return { skipped: true, reason: error.message };
          throw error;
        }
      }));
    } else {
      steps.push({ name: "create_visa_case", status: "skipped", detail: { skipped: true, reason: "No visa details supplied — visa case creation is opt-in on this endpoint, never guessed from booking data." }, error: null, durationMs: 0 });
    }

    // ---- Invoice: skip if this booking already has a non-cancelled one. ----
    steps.push(await runStep("generate_invoice", async () => {
      const existing = await InvoiceModel.findOne({ tenantId, bookingId: booking._id, status: { $ne: "cancelled" } }).select("invoiceNumber").lean();
      if (existing) return { skipped: true, reason: `Invoice ${existing.invoiceNumber} already exists for this booking.` };

      const fakeReq = { auth: { tenantId, id: userId, userId, permissions: ["bookings.update"] }, requestId, params: { bookingId: booking._id.toString() }, body: options.invoice || {} };
      const fakeRes = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
      await GenerateBookingInvoice(fakeReq, fakeRes);
      if (!fakeRes.statusCode || fakeRes.statusCode >= 400) throw new Error(fakeRes.body?.message || "Failed to generate invoice.");
      return { skipped: false, invoiceNumber: fakeRes.body.data.invoiceNumber, invoiceId: fakeRes.body.data._id };
    }));

    // ---- WhatsApp confirmation: skip (never fail the whole run) when the
    // customer has no phone, when no active WhatsApp template is
    // configured for this tenant, or when a prior run already sent one. ----
    steps.push(await runStep("send_whatsapp_confirmation", async () => {
      const customer = await CustomerModel.findOne({ _id: booking.customerId, tenantId }).select("firstName lastName phone preferredLanguage").lean();
      if (!customer?.phone) return { skipped: true, reason: "Customer has no phone on file." };

      // Multi-Language System (PRD "CRM Feature Map by Phase" Phase 3
      // module 37) — CommunicationTemplateService.getPublishedTemplateForSend
      // falls back to the "en" variant if the customer's own locale isn't published.
      const locale = customer.preferredLanguage || "en";
      const templateId = options.whatsapp?.templateId || "booking_confirmation";
      let template;
      try {
        template = await CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId, locale });
      } catch {
        return { skipped: true, reason: `No active WhatsApp template "${templateId}" configured for this tenant.` };
      }
      if (template.channel !== "WhatsApp") return { skipped: true, reason: `Template "${templateId}" is not a WhatsApp template.` };

      const alreadySent = await BookingAutomationRunModel.findOne({
        tenantId, bookingId: booking._id,
        steps: { $elemMatch: { name: "send_whatsapp_confirmation", status: "success" } }
      }).lean();
      if (alreadySent) return { skipped: true, reason: "A confirmation message was already sent for this booking." };

      const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
      const result = await WhatsAppPlatformService.sendWhatsApp({
        tenantId, phone: customer.phone, templateId, locale,
        templateData: { customerName: fullName, bookingReference: booking.bookingNumber || booking.bookingReference },
        sourceModule: "BookingOneClickAutomation", userId
      });
      return { skipped: false, trackingId: result?.trackingId || null };
    }));

    const overallStatus = steps.some((s) => s.status === "failed") ? "partial" : "completed";
    const run = await BookingAutomationRunModel.create({ tenantId, bookingId: booking._id, status: overallStatus, steps, triggeredBy: userId || null });

    await AuditLogModel.create({ action: "booking.one_click_automation.run", module: "Booking", resource: "Booking", resourceId: booking._id.toString(), userId: userId || null, tenantId, details: { runId: run._id.toString(), status: overallStatus } });
    publishEvent("BookingOneClickAutomationRun", { tenantId, bookingId: booking._id.toString(), runId: run._id.toString(), status: overallStatus, performedBy: userId || null });

    return run.toJSON();
  }

  static async listRuns(bookingId, tenantId) {
    return BookingAutomationRunModel.find({ tenantId, bookingId }).sort({ createdAt: -1 }).lean();
  }
}

async function runStep(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, status: detail?.skipped ? "skipped" : "success", detail, error: null, durationMs: Date.now() - start };
  } catch (error) {
    return { name, status: "failed", detail: null, error: error.message, durationMs: Date.now() - start };
  }
}

export default BookingOneClickAutomationService;
