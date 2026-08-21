import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Visa Module PRD §13 "Accounts Integration" (the PRD's own "Important" gap)
// — proves VisaFinanceLinkService posts exactly one Invoice + one
// AccountsReceivable row per priced application, and that calling its
// handler again for the same application never creates a duplicate
// (idempotency, matching BookingFinanceLinkService's own guarantee).

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

const makeCustomer = async (CustomerModel, tenantId, suffix) => CustomerModel.create({
  tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: `Traveler${suffix}`,
  email: `visa-${suffix}@example.com`, phone: "+10000000000"
});

// InvoiceService.issueInvoice's own InvoiceCreated publish is dispatched via
// queueMicrotask (utils/eventBus.js) and AccountsReceivableService.createReceivable
// does real DB round-trips inside its handler, so the receivable isn't
// guaranteed to exist the instant _handleVisaCaseInvoiced resolves — poll for it.
const waitForReceivable = async (AccountsReceivableModel, filter, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await AccountsReceivableModel.find(filter).lean();
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return AccountsReceivableModel.find(filter).lean();
};

const makeVisaCase = async (VisaCaseModel, { tenantId, travelerId, suffix }) => VisaCaseModel.create({
  tenantId,
  caseNumber: `VIS-TEST-${suffix}`,
  travelerId,
  travelerSnapshot: { firstName: "Test", lastName: `Traveler${suffix}`, fullName: `Test Traveler${suffix}`, phone: "+10000000000" },
  destinationCountry: "Testland",
  visaType: "tourist_visa",
  applications: [{
    applicationNumber: `VIS-TEST-${suffix}-APP-1`,
    visaType: "tourist_visa",
    status: "draft",
    vendorCost: 0, governmentFee: 0, insuranceFee: 0, serviceCharges: 0, otherCharges: 0, discount: 0,
    sellingPrice: 0, feeAmount: 0, currency: "USD"
  }]
});

test("VisaFinanceLinkService._handleVisaCaseInvoiced creates exactly one Invoice + one AccountsReceivable row, idempotently", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const InvoiceModel = (await import("../models/InvoiceModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const VisaFinanceLinkService = (await import("../services/VisaFinanceLinkService.js")).default;
  const AccountsReceivableService = (await import("../services/AccountsReceivableService.js")).default;
  // The receivable is created by AccountsReceivableService's own
  // InvoiceCreated listener (server.js's bootstrap normally wires this) —
  // never subscribed in this standalone test process otherwise.
  AccountsReceivableService.initEventListeners();

  const suffix = `${Date.now()}`;
  const tenantId = `test-visafinance-${suffix}`;
  t.after(async () => {
    await Promise.all([
      CustomerModel.deleteMany({ tenantId }),
      VisaCaseModel.deleteMany({ tenantId }),
      InvoiceModel.deleteMany({ tenantId }),
      AccountsReceivableModel.deleteMany({ tenantId })
    ]);
  });

  const traveler = await makeCustomer(CustomerModel, tenantId, suffix);
  const visaCase = await makeVisaCase(VisaCaseModel, { tenantId, travelerId: traveler._id, suffix });
  const applicationNumber = visaCase.applications[0].applicationNumber;

  // Price the application directly on the model (bypassing
  // VisaService.updateApplicationPricing here, which is covered by its own
  // test below) — sets sellingPrice so the handler has something to bill.
  await VisaCaseModel.updateOne(
    { _id: visaCase._id, "applications.applicationNumber": applicationNumber },
    { $set: { "applications.$.sellingPrice": 500, "applications.$.feeAmount": 500 } }
  );

  const payload = { visaCaseId: visaCase._id.toString(), tenantId, applicationNumber, sellingPrice: 500, currency: "USD", travelerId: traveler._id.toString() };

  // First call — should create the invoice/receivable.
  await VisaFinanceLinkService._handleVisaCaseInvoiced(payload);

  const invoicesAfterFirst = await InvoiceModel.find({ tenantId, visaCaseId: visaCase._id }).lean();
  assert.equal(invoicesAfterFirst.length, 1, "exactly one invoice should be created");
  assert.equal(invoicesAfterFirst[0].grandTotal, 500);

  const receivablesAfterFirst = await waitForReceivable(AccountsReceivableModel, { tenantId, invoiceNumber: invoicesAfterFirst[0].invoiceNumber });
  assert.equal(receivablesAfterFirst.length, 1, "exactly one receivable should be created");
  assert.equal(receivablesAfterFirst[0].originalAmount, 500);

  const updatedCase = await VisaCaseModel.findById(visaCase._id).lean();
  const updatedApp = updatedCase.applications.find((a) => a.applicationNumber === applicationNumber);
  assert.ok(updatedApp.invoiceId, "invoiceId should be written back onto the application");
  assert.equal(updatedApp.invoiceNumber, invoicesAfterFirst[0].invoiceNumber);

  // Second call for the SAME application — must be a no-op (idempotency guard).
  await VisaFinanceLinkService._handleVisaCaseInvoiced(payload);

  const invoicesAfterSecond = await InvoiceModel.find({ tenantId, visaCaseId: visaCase._id }).lean();
  assert.equal(invoicesAfterSecond.length, 1, "a repeated call must not create a second invoice");

  const receivablesAfterSecond = await AccountsReceivableModel.find({ tenantId, invoiceNumber: invoicesAfterFirst[0].invoiceNumber }).lean();
  assert.equal(receivablesAfterSecond.length, 1, "a repeated call must not create a second receivable");
});

test("A visa-originated receivable appears in CustomerAccountStatementService's statement", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const InvoiceModel = (await import("../models/InvoiceModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const VisaFinanceLinkService = (await import("../services/VisaFinanceLinkService.js")).default;
  const AccountsReceivableService = (await import("../services/AccountsReceivableService.js")).default;
  // The receivable is created by AccountsReceivableService's own
  // InvoiceCreated listener (server.js's bootstrap normally wires this) —
  // never subscribed in this standalone test process otherwise.
  AccountsReceivableService.initEventListeners();
  const CustomerAccountStatementService = (await import("../services/CustomerAccountStatementService.js")).default;

  const suffix = `stmt-${Date.now()}`;
  const tenantId = `test-visafinance-${suffix}`;
  t.after(async () => {
    await Promise.all([
      CustomerModel.deleteMany({ tenantId }),
      VisaCaseModel.deleteMany({ tenantId }),
      InvoiceModel.deleteMany({ tenantId }),
      AccountsReceivableModel.deleteMany({ tenantId })
    ]);
  });

  const traveler = await makeCustomer(CustomerModel, tenantId, suffix);
  const visaCase = await makeVisaCase(VisaCaseModel, { tenantId, travelerId: traveler._id, suffix });
  const applicationNumber = visaCase.applications[0].applicationNumber;

  await VisaCaseModel.updateOne(
    { _id: visaCase._id, "applications.applicationNumber": applicationNumber },
    { $set: { "applications.$.sellingPrice": 250, "applications.$.feeAmount": 250 } }
  );

  await VisaFinanceLinkService._handleVisaCaseInvoiced({
    visaCaseId: visaCase._id.toString(), tenantId, applicationNumber, sellingPrice: 250, currency: "USD", travelerId: traveler._id.toString()
  });

  await waitForReceivable(AccountsReceivableModel, { tenantId, customerId: traveler._id });

  const statement = await CustomerAccountStatementService.getStatement(traveler._id.toString(), tenantId, {});
  assert.equal(statement.rows.length, 1);
  assert.equal(statement.rows[0].debit, 250);
  assert.equal(statement.totals.totalDebit, 250);
});

after(async () => {
  // InvoiceService.createInvoice generates a PDF via HtmlPdfRenderer's
  // Puppeteer singleton, which otherwise keeps this process alive
  // indefinitely after the tests finish.
  const { closeBrowser } = await import("../services/HtmlPdfRenderer.js");
  await closeBrowser();
  if (dbAvailable) await mongoose.disconnect();
});
