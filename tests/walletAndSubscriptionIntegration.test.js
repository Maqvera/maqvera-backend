import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Finance Module Part 18 Part 4 (Enterprise Collection Features) — proves
// the Wallet top-up -> purchase flow and a Subscription billing cycle end
// to end against a real database, reusing Part 2/3's own real Payment
// Intent + Collection + Collect pipeline rather than a parallel one.
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

test("WalletService: topUp credits real money in, purchase spends it through the real collect flow", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const WalletModel = (await import("../models/WalletModel.js")).default;
  const WalletTransactionModel = (await import("../models/WalletTransactionModel.js")).default;
  const CustomerCollectionModel = (await import("../models/CustomerCollectionModel.js")).default;
  const PaymentIntentModel = (await import("../models/PaymentIntentModel.js")).default;
  const PaymentModel = (await import("../models/PaymentModel.js")).default;
  const ReceiptModel = (await import("../models/ReceiptModel.js")).default;
  const WalletService = (await import("../services/WalletService.js")).default;
  const CustomerCollectionService = (await import("../services/CustomerCollectionService.js")).default;

  const suffix = `wallet-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Wallet", lastName: "Tester",
    email: `wallet-${suffix}@example.com`, phone: "+10000000003"
  });

  t.after(async () => {
    await WalletModel.deleteMany({ tenantId });
    await WalletTransactionModel.deleteMany({ tenantId });
    await CustomerCollectionModel.deleteMany({ tenantId });
    await PaymentIntentModel.deleteMany({ tenantId });
    await PaymentModel.deleteMany({ tenantId });
    await ReceiptModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
  });

  const wallet = await WalletService.createWallet({ customerId: customer._id, currency: "USD" }, tenantId, "tester");
  assert.equal(wallet.balance, 0);

  const topUpResult = await WalletService.topUp(wallet._id, { amount: 200, paymentMethod: "Bank Transfer" }, tenantId, "tester");
  assert.equal(topUpResult.wallet.balance, 200);
  assert.equal(topUpResult.transaction.type, "TopUp");

  const collection = await CustomerCollectionService.createCollectionRequest({
    customerId: customer._id, collectionSource: "Deposit", currency: "USD", amount: 75, paymentMethod: "Bank Transfer"
  }, tenantId, "tester");

  const purchaseResult = await WalletService.purchase(wallet._id, { amount: 75, collectionId: collection._id }, tenantId, "tester");
  assert.equal(purchaseResult.wallet.balance, 125);
  assert.equal(purchaseResult.transaction.type, "Purchase");
  assert.equal(purchaseResult.collection.status, "Collected");

  const reloaded = await WalletModel.findOne({ _id: wallet._id, tenantId }).lean();
  assert.equal(reloaded.balance, 125);
});

test("SubscriptionService: createSubscription + runBillingCycle actually renews through the real Collection/Payment pipeline", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const SubscriptionModel = (await import("../models/SubscriptionModel.js")).default;
  const CustomerCollectionModel = (await import("../models/CustomerCollectionModel.js")).default;
  const PaymentIntentModel = (await import("../models/PaymentIntentModel.js")).default;
  const PaymentModel = (await import("../models/PaymentModel.js")).default;
  const ReceiptModel = (await import("../models/ReceiptModel.js")).default;
  const SubscriptionService = (await import("../services/SubscriptionService.js")).default;

  const suffix = `sub-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Sub", lastName: "Tester",
    email: `sub-${suffix}@example.com`, phone: "+10000000004"
  });

  t.after(async () => {
    await SubscriptionModel.deleteMany({ tenantId });
    await CustomerCollectionModel.deleteMany({ tenantId });
    await PaymentIntentModel.deleteMany({ tenantId });
    await PaymentModel.deleteMany({ tenantId });
    await ReceiptModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
  });

  const subscription = await SubscriptionService.createSubscription({
    customerId: customer._id, planType: "Membership", planName: "Gold Gym Membership", membershipTier: "Gym",
    billingCycle: "Monthly", amount: 49.99, currency: "USD", paymentMethod: "Bank Transfer"
  }, tenantId, "tester");

  assert.equal(subscription.status, "Active");
  assert.equal(subscription.planType, "Membership");

  const renewed = await SubscriptionService.runBillingCycle(subscription._id, tenantId, "tester");
  assert.equal(renewed.status, "Active");
  assert.equal(renewed.retryCount, 0);
  assert.ok(new Date(renewed.currentPeriodEnd) > new Date(subscription.currentPeriodEnd));

  const collections = await CustomerCollectionModel.find({ tenantId, customerId: customer._id }).lean();
  assert.equal(collections.length, 1);
  assert.equal(collections[0].collectionSource, "Membership Renewal");
  assert.equal(collections[0].status, "Collected");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
