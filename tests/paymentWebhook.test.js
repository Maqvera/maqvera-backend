// Per-Tenant Payment Gateway Integration — Issue 5 (webhook receiver).
// A syntactically-valid but non-production test key/secret, set BEFORE
// any other import in this file (node:test runs each file in its own
// process by default, so this never leaks into other test files) — real,
// genuine local HMAC-SHA256 signature verification (`stripe.webhooks.constructEvent`)
// never calls the network, so no real Stripe account is needed to
// exercise it for real; only respects an already-configured real value if
// one exists in this environment, never overwrites it.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_local_signature_verification_only";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_fake_for_local_signature_verification_only";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

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

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
};

/** Real Stripe SDK signing — the exact same HMAC scheme `stripe.webhooks.constructEvent` verifies against, via Stripe's own official `generateTestHeaderString` testing utility. */
const signPayload = async (payloadObject) => {
  const { getStripeClient } = await import("../services/PaymentGatewayService.js");
  const client = await getStripeClient();
  const payload = JSON.stringify(payloadObject);
  const header = client.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return { payload: Buffer.from(payload), header };
};

test("HandleStripeWebhook: rejects an invalid signature with 400, never processes the payload", async () => {
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const req = { body: Buffer.from(JSON.stringify({ id: "evt_fake", type: "account.updated", data: { object: {} } })), headers: { "stripe-signature": "t=1,v1=deadbeef" } };
  const res = fakeRes();
  await HandleStripeWebhook(req, res);

  assert.equal(res.statusCode, 400);
});

test("HandleStripeWebhook: a genuinely valid signature is accepted", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const eventId = `evt_valid_${Date.now()}`;
  t.after(async () => { await PaymentWebhookEventModel.deleteMany({ stripeEventId: eventId }); });

  const { payload, header } = await signPayload({ id: eventId, type: "some.unhandled.event", data: { object: {} } });
  const req = { body: payload, headers: { "stripe-signature": header } };
  const res = fakeRes();
  await HandleStripeWebhook(req, res);

  assert.equal(res.statusCode, 200);
  const record = await PaymentWebhookEventModel.findOne({ stripeEventId: eventId }).lean();
  assert.ok(record, "a real event record must be persisted");
  assert.equal(record.status, "Ignored", "an event type this integration doesn't act on, and/or no matching tenant, must be honestly Ignored, never silently dropped from view");
});

test("HandleStripeWebhook: no matching tenant for the connected account is honestly ignored, never assumed", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const eventId = `evt_notenant_${Date.now()}`;
  t.after(async () => { await PaymentWebhookEventModel.deleteMany({ stripeEventId: eventId }); });

  const { payload, header } = await signPayload({ id: eventId, type: "account.updated", account: "acct_no_such_tenant_has_this", data: { object: { id: "acct_no_such_tenant_has_this", charges_enabled: true, payouts_enabled: true } } });
  const req = { body: payload, headers: { "stripe-signature": header } };
  const res = fakeRes();
  await HandleStripeWebhook(req, res);

  assert.equal(res.statusCode, 200, "Stripe must still receive a 2xx so it stops retrying an event we've genuinely decided not to act on");
  const record = await PaymentWebhookEventModel.findOne({ stripeEventId: eventId }).lean();
  assert.equal(record.status, "Ignored");
  assert.equal(record.tenantId, null);
});

test("HandleStripeWebhook: replaying the exact same event.id does not reprocess it (real idempotency)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const suffix = `webhookidem-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const accountId = `acct_${suffix}`;
  const eventId = `evt_${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PaymentWebhookEventModel.deleteMany({ stripeEventId: eventId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: "Test Tenant", status: "active", paymentGateways: [{ provider: "stripe", accountId, status: "connected", connectedAt: new Date() }] });

  const { payload, header } = await signPayload({ id: eventId, type: "account.updated", account: accountId, data: { object: { id: accountId, charges_enabled: true, payouts_enabled: false } } });

  const firstRes = fakeRes();
  await HandleStripeWebhook({ body: payload, headers: { "stripe-signature": header } }, firstRes);
  assert.equal(firstRes.statusCode, 200);

  const reloadedAfterFirst = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedAfterFirst.paymentGateways[0].chargesEnabled, true, "the first, genuine delivery must actually be processed");

  // Simulate Stripe re-flipping the flag server-side, then RETRYING the
  // exact same event.id (the real scenario this idempotency check exists
  // for) — the replay must be acknowledged but NOT reprocessed.
  await TenantModel.updateOne({ tenantKey: tenantId }, { $set: { "paymentGateways.0.chargesEnabled": false } });

  const secondRes = fakeRes();
  await HandleStripeWebhook({ body: payload, headers: { "stripe-signature": header } }, secondRes);
  assert.equal(secondRes.statusCode, 200, "a duplicate delivery must still be acknowledged with 2xx");

  const reloadedAfterSecond = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloadedAfterSecond.paymentGateways[0].chargesEnabled, false, "the replayed event must NOT be reprocessed — the manually-flipped value must remain untouched");

  const records = await PaymentWebhookEventModel.find({ stripeEventId: eventId }).lean();
  assert.equal(records.length, 1, "exactly one event record must exist regardless of how many times the same event.id was delivered");
});

test("HandleStripeWebhook: account.updated genuinely syncs real Stripe Connect capability flags onto the matching tenant", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const suffix = `webhooksync-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const accountId = `acct_${suffix}`;
  const eventId = `evt_${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PaymentWebhookEventModel.deleteMany({ stripeEventId: eventId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: "Test Tenant", status: "active", paymentGateways: [{ provider: "stripe", accountId, status: "connected", chargesEnabled: false, payoutsEnabled: false, connectedAt: new Date() }] });

  const { payload, header } = await signPayload({ id: eventId, type: "account.updated", account: accountId, data: { object: { id: accountId, charges_enabled: true, payouts_enabled: true } } });
  const res = fakeRes();
  await HandleStripeWebhook({ body: payload, headers: { "stripe-signature": header } }, res);

  assert.equal(res.statusCode, 200);
  const reloaded = await TenantModel.findOne({ tenantKey: tenantId }).lean();
  assert.equal(reloaded.paymentGateways[0].chargesEnabled, true);
  assert.equal(reloaded.paymentGateways[0].payoutsEnabled, true);

  const record = await PaymentWebhookEventModel.findOne({ stripeEventId: eventId }).lean();
  assert.equal(record.status, "Processed");
  assert.equal(record.tenantId, tenantId);
});

test("HandleStripeWebhook: payment_intent.succeeded genuinely updates the correlated booking end-to-end via BookingPaymentService", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const suffix = `webhookbooking-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const accountId = `acct_${suffix}`;
  const eventId = `evt_${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await BookingHeaderModel.deleteMany({ tenantId });
    await PaymentWebhookEventModel.deleteMany({ stripeEventId: eventId });
  });

  await TenantModel.create({ tenantKey: tenantId, name: "Test Tenant", status: "active", paymentGateways: [{ provider: "stripe", accountId, status: "connected", connectedAt: new Date() }] });
  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 250, financialSnapshot: { totalAmount: 250, paidAmount: 0, outstandingBalance: 250, paymentStatus: "unpaid" }
  });

  const { payload, header } = await signPayload({
    id: eventId, type: "payment_intent.succeeded", account: accountId,
    data: { object: { id: "pi_test_real", amount: 25000, amount_received: 25000, currency: "usd", metadata: { bookingId: booking._id.toString() } } }
  });

  const res = fakeRes();
  await HandleStripeWebhook({ body: payload, headers: { "stripe-signature": header } }, res);
  assert.equal(res.statusCode, 200);

  const reloadedBooking = await BookingHeaderModel.findOne({ _id: booking._id }).lean();
  assert.equal(reloadedBooking.financialSnapshot.paidAmount, 250, "amount_received is in cents — must be correctly converted to real currency units");
  assert.equal(reloadedBooking.paymentStatus, "fully_paid");

  const record = await PaymentWebhookEventModel.findOne({ stripeEventId: eventId }).lean();
  assert.equal(record.status, "Processed");
});

test("HandleStripeWebhook: charge.refunded across two events correctly computes the real per-event delta from Stripe's cumulative amount_refunded, never double-counting", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const suffix = `webhookrefund-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const accountId = `acct_${suffix}`;
  const eventId1 = `evt_${suffix}_1`;
  const eventId2 = `evt_${suffix}_2`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await BookingHeaderModel.deleteMany({ tenantId });
    await PaymentWebhookEventModel.deleteMany({ stripeEventId: { $in: [eventId1, eventId2] } });
  });

  await TenantModel.create({ tenantKey: tenantId, name: "Test Tenant", status: "active", paymentGateways: [{ provider: "stripe", accountId, status: "connected", connectedAt: new Date() }] });
  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 300, paidAmount: 300, financialSnapshot: { totalAmount: 300, paidAmount: 300, outstandingBalance: 0, paymentStatus: "fully_paid" }
  });

  // First real refund: $100 of $300 refunded so far (cumulative).
  const first = await signPayload({ id: eventId1, type: "charge.refunded", account: accountId, data: { object: { id: "ch_test_real", amount_refunded: 10000, metadata: { bookingId: booking._id.toString() } } } });
  await HandleStripeWebhook({ body: first.payload, headers: { "stripe-signature": first.header } }, fakeRes());

  const afterFirst = await BookingHeaderModel.findOne({ _id: booking._id }).lean();
  assert.equal(afterFirst.financialSnapshot.refundAmount, 100);
  assert.equal(afterFirst.financialSnapshot.paidAmount, 200);

  // Second real refund on the SAME charge: Stripe reports the cumulative
  // total is now $180 — the real per-event delta is $80, not $180.
  const second = await signPayload({ id: eventId2, type: "charge.refunded", account: accountId, data: { object: { id: "ch_test_real", amount_refunded: 18000, metadata: { bookingId: booking._id.toString() } } } });
  await HandleStripeWebhook({ body: second.payload, headers: { "stripe-signature": second.header } }, fakeRes());

  const afterSecond = await BookingHeaderModel.findOne({ _id: booking._id }).lean();
  assert.equal(afterSecond.financialSnapshot.refundAmount, 180, "must reflect Stripe's real cumulative total, not double-count");
  assert.equal(afterSecond.financialSnapshot.paidAmount, 120, "300 - 180 = 120, never double-decremented to 20");
});

test("HandleStripeWebhook: absolute cross-tenant safety — tenant A's own Stripe account event can never touch tenant B's booking, even given tenant B's real bookingId", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const PaymentWebhookEventModel = (await import("../models/PaymentWebhookEventModel.js")).default;
  const { HandleStripeWebhook } = await import("../controllers/PaymentWebhookController.js");

  const suffix = `webhookcross-${Date.now()}`;
  const tenantAId = `test-${suffix}-a`;
  const tenantBId = `test-${suffix}-b`;
  const accountA = `acct_${suffix}_a`;
  const eventId = `evt_${suffix}`;

  t.after(async () => {
    await TenantModel.deleteMany({ tenantKey: { $in: [tenantAId, tenantBId] } });
    await BookingHeaderModel.deleteMany({ tenantId: { $in: [tenantAId, tenantBId] } });
    await PaymentWebhookEventModel.deleteMany({ stripeEventId: eventId });
  });

  await TenantModel.create({ tenantKey: tenantAId, name: "Tenant A", status: "active", paymentGateways: [{ provider: "stripe", accountId: accountA, status: "connected", connectedAt: new Date() }] });
  await TenantModel.create({ tenantKey: tenantBId, name: "Tenant B", status: "active" });
  const bookingB = await BookingHeaderModel.create({
    tenantId: tenantBId, bookingReference: `BK-${suffix}-B`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 999, financialSnapshot: { totalAmount: 999, paidAmount: 0, outstandingBalance: 999, paymentStatus: "unpaid" }
  });

  // A webhook event genuinely signed for Tenant A's own connected Stripe
  // account, but (accidentally or maliciously) carrying Tenant B's real
  // bookingId in its metadata.
  const { payload, header } = await signPayload({
    id: eventId, type: "payment_intent.succeeded", account: accountA,
    data: { object: { id: "pi_cross_tenant", amount: 99900, amount_received: 99900, currency: "usd", metadata: { bookingId: bookingB._id.toString() } } }
  });

  const res = fakeRes();
  await HandleStripeWebhook({ body: payload, headers: { "stripe-signature": header } }, res);

  // The event is genuinely tenant-A-resolved (Tenant A owns accountA), so
  // markPaid is attempted scoped to tenantId=A with tenant B's bookingId —
  // BookingHeaderModel has no such document under tenant A, so it
  // genuinely fails to find it. This must be recorded as a real
  // processing Error (never silently "Processed"), and Tenant B's actual
  // booking must remain completely untouched.
  const record = await PaymentWebhookEventModel.findOne({ stripeEventId: eventId }).lean();
  assert.equal(record.status, "Error", "a cross-tenant bookingId must genuinely fail to resolve, never silently succeed against the wrong tenant's data");

  const reloadedBookingB = await BookingHeaderModel.findOne({ _id: bookingB._id }).lean();
  assert.equal(reloadedBookingB.financialSnapshot.paidAmount, 0, "tenant B's real booking must be completely untouched by tenant A's webhook event");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
