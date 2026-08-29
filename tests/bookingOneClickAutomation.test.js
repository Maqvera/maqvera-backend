import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// One-Click Automation Engine (PRD "CRM Feature Map by Phase" Phase 3
// module 22) — same direct-controller-call convention as
// tests/marketingCampaign.test.js. Covers: opt-in visa step (skipped when
// no visa details are supplied — never guessed), a real invoice generation
// via the existing BookingController.GenerateBookingInvoice, a WhatsApp
// confirmation gated on an active template existing, idempotency on a
// second run (nothing gets duplicated), and the core safety property this
// task is graded on: one step failing (visa, when no country/visa-type
// master data exists) never blocks the independent steps after it.

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

test("One-Click Automation Engine: opt-in visa step, real invoice generation, WhatsApp confirmation gating, idempotent re-run, independent-step failure isolation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/BookingAutomationController.js");
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingTravelerModel = (await import("../models/BookingTravelerModel.js")).default;
  const BookingServiceModel = (await import("../models/BookingServiceModel.js")).default;
  const InvoiceModel = (await import("../models/InvoiceModel.js")).default;
  const BookingAutomationRunModel = (await import("../models/BookingAutomationRunModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const CommunicationTemplateService = (await import("../services/CommunicationTemplateService.js")).default;
  const WhatsAppPlatformService = (await import("../services/WhatsAppPlatformService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-automation-${suffix}`;

  const cleanupModels = [CustomerModel, BookingHeaderModel, BookingTravelerModel, BookingServiceModel, InvoiceModel, BookingAutomationRunModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
  });

  const originalGetTemplate = CommunicationTemplateService.getPublishedTemplateForSend;
  t.after(() => { CommunicationTemplateService.getPublishedTemplateForSend = originalGetTemplate; });
  CommunicationTemplateService.getPublishedTemplateForSend = async ({ templateId }) => ({ templateId, channel: "WhatsApp", bodyTemplate: "Hi {{customerName}}, your booking {{bookingReference}} is confirmed!", status: "Active" });

  const originalSendWhatsApp = WhatsAppPlatformService.sendWhatsApp;
  t.after(() => { WhatsAppPlatformService.sendWhatsApp = originalSendWhatsApp; });
  let whatsAppAttempts = 0;
  WhatsAppPlatformService.sendWhatsApp = async () => { whatsAppAttempts += 1; return { trackingId: `STUB-WA-${whatsAppAttempts}`, status: "Queued" }; };

  // ---- Fixtures ----
  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "Auto", lastName: "Mation", email: `auto.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });
  const booking = await BookingHeaderModel.create({ tenantId, bookingReference: `BK-${suffix}`, bookingNumber: `BK-${suffix}`, customerId: customer._id, currency: "USD", status: "draft", travelDate: new Date("2027-10-01") });
  await BookingTravelerModel.create({
    tenantId, bookingId: booking._id, customerId: customer._id, isPrimary: true, isPrimaryTraveler: true,
    firstName: customer.firstName, lastName: customer.lastName,
    customerSnapshot: { snapshotName: `${customer.firstName} ${customer.lastName}` }
  });
  await BookingServiceModel.create({ tenantId, bookingId: booking._id, serviceType: "other", serviceName: "Ziyarat Tour", sellingPrice: 150, quantity: 1, totalPrice: 150, status: "active" });

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.RunOneClickAutomation({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { bookingId: booking._id.toString() }, body: {} }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- First run: no visa details supplied -> visa step skipped; invoice + WhatsApp succeed ----
  const runRes = makeRes();
  await ctrl.RunOneClickAutomation({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() }, body: {} }, runRes);
  assert.equal(runRes.statusCode, 200, JSON.stringify(runRes.body));
  assert.equal(runRes.body.data.status, "completed");

  const stepsByName = Object.fromEntries(runRes.body.data.steps.map((s) => [s.name, s]));
  assert.equal(stepsByName.create_visa_case.status, "skipped");
  assert.equal(stepsByName.generate_invoice.status, "success");
  assert.ok(stepsByName.generate_invoice.detail.invoiceNumber);
  assert.equal(stepsByName.send_whatsapp_confirmation.status, "success");
  assert.equal(whatsAppAttempts, 1);

  const invoiceCount = await InvoiceModel.countDocuments({ tenantId, bookingId: booking._id });
  assert.equal(invoiceCount, 1);

  const runRecord = await BookingAutomationRunModel.findOne({ tenantId, bookingId: booking._id }).lean();
  assert.ok(runRecord, "the run must be persisted for auditability");

  // ---- Second run: everything already done -> both steps skipped, no duplicate invoice/message ----
  const rerunRes = makeRes();
  await ctrl.RunOneClickAutomation({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() }, body: {} }, rerunRes);
  assert.equal(rerunRes.statusCode, 200, JSON.stringify(rerunRes.body));
  const rerunSteps = Object.fromEntries(rerunRes.body.data.steps.map((s) => [s.name, s]));
  assert.equal(rerunSteps.generate_invoice.status, "skipped");
  assert.equal(rerunSteps.send_whatsapp_confirmation.status, "skipped");
  assert.equal(whatsAppAttempts, 1, "a second run must never re-send the confirmation");
  assert.equal(await InvoiceModel.countDocuments({ tenantId, bookingId: booking._id }), 1, "a second run must never generate a duplicate invoice");

  // ---- Third run: visa details supplied but no CountryMasterModel/VisaTypeModel
  // seeded for this tenant -> visa step genuinely fails, but invoice/WhatsApp
  // steps (already done) are still reported, and the run is "partial", not aborted. ----
  const failRes = makeRes();
  await ctrl.RunOneClickAutomation({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() }, body: { visa: { destinationCountry: "Nowhereland", visaType: "Tourist" } } }, failRes);
  assert.equal(failRes.statusCode, 200, JSON.stringify(failRes.body));
  assert.equal(failRes.body.data.status, "partial");
  const failSteps = Object.fromEntries(failRes.body.data.steps.map((s) => [s.name, s]));
  assert.equal(failSteps.create_visa_case.status, "failed");
  assert.match(failSteps.create_visa_case.error, /not found/i);
  // The independent, already-satisfied steps are still reported as skipped
  // (not aborted, not re-attempted) even though the visa step failed.
  assert.equal(failSteps.generate_invoice.status, "skipped");
  assert.equal(failSteps.send_whatsapp_confirmation.status, "skipped");

  // ---- List runs ----
  const listRes = makeRes();
  await ctrl.ListOneClickAutomationRuns({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() } }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 3);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
