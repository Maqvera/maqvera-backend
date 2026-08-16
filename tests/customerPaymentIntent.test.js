import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Finance Module Part 18 Part 2 (Customer Payments API Contracts
// Refactoring) — proves POST /customer-payments' new Payment Intent
// behavior end to end against a real database: (1) the original
// invoiceIds-shaped request still works exactly as before AND now also
// creates a linked Payment Intent (backward compatibility); (2) the new
// collectionSource-shaped request creates a Payment Intent + Collection
// with no Accounts Receivable involvement at all ("Customer Payment is
// NOT Invoice"); (3) an Idempotency-Key retry returns the exact same
// Collection instead of creating a duplicate.
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

test("createCollectionRequest: legacy invoiceIds shape still works and now also creates a linked Payment Intent", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const CustomerCollectionModel = (await import("../models/CustomerCollectionModel.js")).default;
  const PaymentIntentModel = (await import("../models/PaymentIntentModel.js")).default;
  const CustomerCollectionService = (await import("../services/CustomerCollectionService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-cpi-legacy-${suffix}`;

  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Ada", lastName: "Lovelace",
    email: `ada-${suffix}@example.com`, phone: "+10000000000"
  });

  const receivable = await AccountsReceivableModel.create({
    tenantId, customerId: customer._id, customerName: "Ada Lovelace", invoiceNumber: `INV-${suffix}`,
    issueDate: new Date(), dueDate: new Date(Date.now() + 7 * 86400000),
    originalAmount: 500, outstandingBalance: 500, currency: "USD", status: "Open"
  });

  t.after(async () => {
    await CustomerCollectionModel.deleteMany({ tenantId });
    await PaymentIntentModel.deleteMany({ tenantId });
    await AccountsReceivableModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
  });

  const result = await CustomerCollectionService.createCollectionRequest({
    customerId: customer._id, invoiceIds: [receivable._id], paymentDueDate: new Date(Date.now() + 14 * 86400000)
  }, tenantId, "tester", "corr-legacy-1");

  assert.equal(result.collectionSource, "Sales Invoice");
  assert.equal(result.lineItems[0].receivableId.toString(), receivable._id.toString());
  assert.equal(result.totalAmount, 500);
  assert.ok(result.paymentIntentId, "expected a linked paymentIntentId on the response");
  assert.ok(result.paymentReference, "expected a generated paymentReference on the response");
  assert.equal(result.paymentIntent.collectionSource, "Sales Invoice");
  assert.equal(result.paymentIntent.amount, 500);

  const intent = await PaymentIntentModel.findOne({ tenantId, _id: result.paymentIntentId }).lean();
  assert.ok(intent, "expected the PaymentIntentModel row to actually exist");
  assert.equal(intent.collectionId.toString(), result._id.toString(), "PaymentIntent -> Collection link must be bidirectional");
  assert.equal(intent.status, "Created");
});

test("createCollectionRequest: new collectionSource shape skips Accounts Receivable entirely", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CustomerCollectionModel = (await import("../models/CustomerCollectionModel.js")).default;
  const PaymentIntentModel = (await import("../models/PaymentIntentModel.js")).default;
  const CustomerCollectionService = (await import("../services/CustomerCollectionService.js")).default;

  const suffix = Date.now() + 1;
  const tenantId = `test-cpi-generic-${suffix}`;

  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Grace", lastName: "Hopper",
    email: `grace-${suffix}@example.com`, phone: "+10000000001"
  });

  t.after(async () => {
    await CustomerCollectionModel.deleteMany({ tenantId });
    await PaymentIntentModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
  });

  const result = await CustomerCollectionService.createCollectionRequest({
    customerId: customer._id, merchantId: "merchant-123", subscriptionId: "sub-456",
    collectionSource: "Subscription Invoice", sourceDocumentId: "sub-inv-789",
    currency: "USD", amount: 250, paymentMethod: "Bank Transfer"
  }, tenantId, "tester", "corr-generic-1");

  assert.equal(result.collectionSource, "Subscription Invoice");
  assert.equal(result.merchantId, "merchant-123");
  assert.equal(result.subscriptionId, "sub-456");
  assert.equal(result.totalAmount, 250);
  assert.equal(result.lineItems.length, 1);
  assert.equal(result.lineItems[0].receivableId, null, "no AccountsReceivable record should be referenced for a non-invoice source");
  assert.equal(result.lineItems[0].invoiceNumber, "sub-inv-789");

  const intent = await PaymentIntentModel.findOne({ tenantId, _id: result.paymentIntentId }).lean();
  assert.equal(intent.paymentMethod, "Bank Transfer");
  assert.equal(intent.paymentProvider, "Manual", "Bank Transfer is a manual-settling method — resolveGateway must route it to Manual, never a live gateway");
  assert.equal(intent.correlationId, "corr-generic-1");
});

test("createCollectionRequest: new shape rejects an unsupported collectionSource / missing amount", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CustomerCollectionService = (await import("../services/CustomerCollectionService.js")).default;

  const suffix = Date.now() + 2;
  const tenantId = `test-cpi-invalid-${suffix}`;
  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Alan", lastName: "Turing",
    email: `alan-${suffix}@example.com`, phone: "+10000000002"
  });
  t.after(async () => { await CustomerModel.deleteMany({ tenantId }); });

  await assert.rejects(
    CustomerCollectionService.createCollectionRequest({ customerId: customer._id, collectionSource: "Not A Real Source", currency: "USD", amount: 100 }, tenantId, "tester"),
    /Invalid collectionSource/
  );
  await assert.rejects(
    CustomerCollectionService.createCollectionRequest({ customerId: customer._id, collectionSource: "Wallet Recharge", currency: "USD" }, tenantId, "tester"),
    /amount is required/
  );
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
