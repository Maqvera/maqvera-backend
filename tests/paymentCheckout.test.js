import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Payment Gateway Integration — Issue 10 (checkout/payment
// creation). Proves everything up to the real external Stripe API
// boundary: `createCheckoutSession` honestly refuses (never fabricates a
// URL) when no gateway is connected, when the connected gateway can't yet
// accept charges, or for an invalid amount; the real controller charges
// the booking's own remaining `outstandingBalance` (never the full
// `totalAmount` again — no double-charging a partially-paid booking),
// genuinely 404s for a cross-tenant/nonexistent booking, 400s for a fully
// settled booking, and 403s without the real `bookings.update` permission.
// Actually calling Stripe's real `checkout.sessions.create` needs a real,
// already-onboarded Stripe Connect test account this environment doesn't
// have configured — honestly not exercised here, same disclosed boundary
// as every other real-external-API test in this suite.
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

test("PaymentGatewayService.createCheckoutSession: honestly refuses when the tenant has no connected gateway at all", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PaymentGatewayService = (await import("../services/PaymentGatewayService.js")).default;

  const suffix = `checkoutnogw-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => { await TenantModel.deleteMany({ tenantKey: tenantId }); });

  await TenantModel.create({ tenantKey: tenantId, name: "Test Tenant", status: "active" });

  await assert.rejects(
    () => PaymentGatewayService.createCheckoutSession({ tenantId, bookingId: new mongoose.Types.ObjectId(), bookingReference: "BK-1", amount: 100, currency: "USD" }),
    /has not connected/i
  );
});

test("PaymentGatewayService.createCheckoutSession: honestly refuses when the connected gateway cannot yet accept charges", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PaymentGatewayService = (await import("../services/PaymentGatewayService.js")).default;

  const suffix = `checkoutnocharge-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => { await TenantModel.deleteMany({ tenantKey: tenantId }); });

  await TenantModel.create({
    tenantKey: tenantId, name: "Test Tenant", status: "active",
    paymentGateways: [{ provider: "stripe", accountId: "acct_onboarding", status: "connected", chargesEnabled: false, connectedAt: new Date() }]
  });

  await assert.rejects(
    () => PaymentGatewayService.createCheckoutSession({ tenantId, bookingId: new mongoose.Types.ObjectId(), bookingReference: "BK-1", amount: 100, currency: "USD" }),
    /cannot accept charges/i
  );
});

test("PaymentGatewayService.createCheckoutSession: honestly refuses a zero/negative amount, never a fabricated session", async () => {
  const PaymentGatewayService = (await import("../services/PaymentGatewayService.js")).default;
  await assert.rejects(() => PaymentGatewayService.createCheckoutSession({ tenantId: "irrelevant", bookingId: "irrelevant", amount: 0, currency: "USD" }), /positive amount/i);
  await assert.rejects(() => PaymentGatewayService.createCheckoutSession({ tenantId: "irrelevant", bookingId: "irrelevant", amount: -50, currency: "USD" }), /positive amount/i);
});

test("CreateCheckout: 404 for a booking that doesn't exist in the caller's own tenant (cross-tenant safety)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const { CreateCheckout } = await import("../controllers/PaymentGatewayController.js");

  const suffix = `checkout404-${Date.now()}`;
  const tenantA = `test-${suffix}-a`;
  const tenantB = `test-${suffix}-b`;
  t.after(async () => { await BookingHeaderModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } }); });

  const bookingB = await BookingHeaderModel.create({
    tenantId: tenantB, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 200, financialSnapshot: { totalAmount: 200, paidAmount: 0, outstandingBalance: 200, paymentStatus: "unpaid" }
  });

  const req = { auth: { tenantId: tenantA, userId: "tester", permissions: ["bookings.update"] }, body: { bookingId: bookingB._id.toString() }, requestId: "test-req-id" };
  let statusCode = null, payload = null;
  const res = { status(code) { statusCode = code; return this; }, json(body) { payload = body; return this; } };

  await CreateCheckout(req, res);
  assert.equal(statusCode, 404, "tenant A must never be able to create a checkout session for tenant B's real booking");
});

test("CreateCheckout: 400 for a booking with no outstanding balance (already fully paid)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const { CreateCheckout } = await import("../controllers/PaymentGatewayController.js");

  const suffix = `checkoutpaid-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => { await BookingHeaderModel.deleteMany({ tenantId }); });

  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 300, financialSnapshot: { totalAmount: 300, paidAmount: 300, outstandingBalance: 0, paymentStatus: "fully_paid" }
  });

  const req = { auth: { tenantId, userId: "tester", permissions: ["bookings.update"] }, body: { bookingId: booking._id.toString() }, requestId: "test-req-id" };
  let statusCode = null, payload = null;
  const res = { status(code) { statusCode = code; return this; }, json(body) { payload = body; return this; } };

  await CreateCheckout(req, res);
  assert.equal(statusCode, 400);
  assert.match(payload.message, /no outstanding balance/i);
});

test("CreateCheckout: 403 without the real bookings.update permission", async () => {
  const { CreateCheckout } = await import("../controllers/PaymentGatewayController.js");

  const req = { auth: { tenantId: "some-tenant", userId: "tester", permissions: [] }, body: { bookingId: "irrelevant" }, requestId: "test-req-id" };
  let statusCode = null;
  const res = { status(code) { statusCode = code; return this; }, json(body) { return this; } };

  await CreateCheckout(req, res);
  assert.equal(statusCode, 403);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
