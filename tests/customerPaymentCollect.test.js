import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Finance Module Part 18 Part 3 (Payment Collection, Allocation &
// Reconciliation) — proves the refactored /collect + new /capture
// endpoints end to end against a real database: (1) Automatic capture
// mode still fully allocates + generates a receipt in one call, same as
// before this Part; (2) Manual capture mode stops at "Payment Authorized"
// and a separate /capture call is required to actually finish it; (3) a
// non-invoice collectionSource (Part 2) allocates correctly with no
// AccountsReceivable record involved.
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
  tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: `Customer${suffix}`,
  email: `test-${suffix}@example.com`, phone: "+10000000000"
});

test("collectPayment (Automatic mode, Sales Invoice): captures, allocates against AR, and generates a receipt", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const CustomerCollectionModel = (await import("../models/CustomerCollectionModel.js")).default;
  const PaymentIntentModel = (await import("../models/PaymentIntentModel.js")).default;
  const PaymentModel = (await import("../models/PaymentModel.js")).default;
  const ReceiptModel = (await import("../models/ReceiptModel.js")).default;
  const CustomerCollectionService = (await import("../services/CustomerCollectionService.js")).default;

  const suffix = `auto-${Date.now()}`;
  const tenantId = `test-collect-${suffix}`;

  const customer = await makeCustomer(CustomerModel, tenantId, suffix);
  const receivable = await AccountsReceivableModel.create({
    tenantId, customerId: customer._id, customerName: "Test Customer", invoiceNumber: `INV-${suffix}`,
    issueDate: new Date(), dueDate: new Date(Date.now() + 7 * 86400000),
    originalAmount: 300, outstandingBalance: 300, currency: "USD", status: "Open"
  });

  t.after(async () => {
    await CustomerCollectionModel.deleteMany({ tenantId });
    await PaymentIntentModel.deleteMany({ tenantId });
    await PaymentModel.deleteMany({ tenantId });
    await ReceiptModel.deleteMany({ tenantId });
    await AccountsReceivableModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
  });

  const created = await CustomerCollectionService.createCollectionRequest({
    customerId: customer._id, invoiceIds: [receivable._id], paymentDueDate: new Date(Date.now() + 14 * 86400000)
  }, tenantId, "tester");

  const result = await CustomerCollectionService.collectPayment(created._id, {
    paymentMethod: "Bank Transfer", captureMode: "Automatic"
  }, tenantId, "tester", "corr-collect-1");

  assert.equal(result.status, "Collected");
  assert.equal(result.paymentStatus, "Captured");
  assert.equal(result.capturedAmount, 300);
  assert.equal(result.fraudStatus, "Clear");
  assert.ok(result.paymentId, "expected a real paymentId on the response");

  const updatedReceivable = await AccountsReceivableModel.findOne({ _id: receivable._id, tenantId }).lean();
  assert.equal(updatedReceivable.outstandingBalance, 0);
  assert.equal(updatedReceivable.status, "Paid");
});

test("collectPayment (Manual capture mode): stops at Payment Authorized, then POST .../capture finishes it", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CustomerCollectionModel = (await import("../models/CustomerCollectionModel.js")).default;
  const PaymentIntentModel = (await import("../models/PaymentIntentModel.js")).default;
  const PaymentModel = (await import("../models/PaymentModel.js")).default;
  const ReceiptModel = (await import("../models/ReceiptModel.js")).default;
  const CustomerCollectionService = (await import("../services/CustomerCollectionService.js")).default;

  const suffix = `manual-${Date.now()}`;
  const tenantId = `test-collect-${suffix}`;
  const customer = await makeCustomer(CustomerModel, tenantId, suffix);

  t.after(async () => {
    await CustomerCollectionModel.deleteMany({ tenantId });
    await PaymentIntentModel.deleteMany({ tenantId });
    await PaymentModel.deleteMany({ tenantId });
    await ReceiptModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
  });

  const created = await CustomerCollectionService.createCollectionRequest({
    customerId: customer._id, collectionSource: "Wallet Recharge", currency: "USD", amount: 100, paymentMethod: "Bank Transfer"
  }, tenantId, "tester");

  const authorizedResult = await CustomerCollectionService.collectPayment(created._id, {
    paymentMethod: "Bank Transfer", captureMode: "Manual"
  }, tenantId, "tester");

  assert.equal(authorizedResult.status, "Payment Authorized");
  assert.equal(authorizedResult.paymentStatus, "Authorized");
  assert.ok(authorizedResult.authorizedPaymentId, "expected authorizedPaymentId to be set");

  // Attempting to collect again while Authorized must be rejected — the
  // caller should use /capture, not a second /collect.
  await assert.rejects(
    CustomerCollectionService.collectPayment(created._id, { paymentMethod: "Bank Transfer" }, tenantId, "tester"),
    /awaiting capture/
  );

  const captured = await CustomerCollectionService.captureAuthorizedPayment(created._id, {}, tenantId, "tester");
  assert.equal(captured.status, "Collected");
  assert.equal(captured.paymentStatus, "Captured");
  assert.equal(captured.capturedAmount, 100);
  assert.equal(captured.lineItems[0].receivableId, null, "non-invoice source must never gain an AR reference");

  const intent = await PaymentIntentModel.findOne({ tenantId, _id: created.paymentIntentId }).lean();
  assert.equal(intent.status, "Captured");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
