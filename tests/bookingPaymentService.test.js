import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Payment Gateway Integration — Issue 6 (BookingPaymentService).
// Proves: real partial-then-full payment math on `BookingHeaderModel`'s
// own `financialSnapshot` (never overwritten, always additive); the
// correct `paymentStatus` transitions (`partially_paid` -> `fully_paid`);
// a real workflow transition (`Confirm Booking`) genuinely fires only
// when a `reserved` booking becomes fully paid, and is a silent, safe
// no-op from any other workflow state; refunds correctly decrement
// (never below zero); and tenant isolation is absolute — a payment can
// never be applied to a different tenant's booking.
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

test("BookingPaymentService.markPaid: real additive partial-then-full payment math, correct paymentStatus transitions, and a real workflow confirmation on reaching fully_paid from reserved", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const WorkflowInstanceModel = (await import("../models/WorkflowInstanceModel.js")).default;
  const BookingPaymentService = (await import("../services/BookingPaymentService.js")).default;

  const suffix = `bpay-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId });
    await WorkflowInstanceModel.deleteMany({ tenantId });
  });

  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(), status: "reserved",
    totalAmount: 1000, financialSnapshot: { totalAmount: 1000, paidAmount: 0, outstandingBalance: 1000, paymentStatus: "unpaid" }
  });

  // Real, matching workflow instance — `reserved`, matching the booking's
  // own denormalized `status`, so "Confirm Booking" (fromState: reserved)
  // is genuinely a valid transition when payment completes below.
  await WorkflowInstanceModel.create({
    tenantId, entityType: "Booking", entityId: booking._id, currentState: "reserved", completedSteps: ["draft", "quotation", "reserved"],
    history: [{ fromState: "draft", toState: "reserved", action: "Reserve", performedBy: "tester", timestamp: new Date() }]
  });

  const afterFirst = await BookingPaymentService.markPaid({ tenantId, bookingId: booking._id, amountPaid: 400, currency: "USD", stripePaymentIntentId: "pi_test_1" });
  assert.equal(afterFirst.financialSnapshot.paidAmount, 400);
  assert.equal(afterFirst.financialSnapshot.outstandingBalance, 600);
  assert.equal(afterFirst.paymentStatus, "partially_paid");
  assert.equal(afterFirst.financialSnapshot.paymentStatus, "partially_paid");

  const workflowAfterFirst = await WorkflowInstanceModel.findOne({ tenantId, entityId: booking._id }).lean();
  assert.equal(workflowAfterFirst.currentState, "reserved", "a partial payment must never trigger a workflow transition");

  const afterSecond = await BookingPaymentService.markPaid({ tenantId, bookingId: booking._id, amountPaid: 600, currency: "USD", stripePaymentIntentId: "pi_test_2" });
  assert.equal(afterSecond.financialSnapshot.paidAmount, 1000, "the second payment must be ADDED to the first, never a replacement");
  assert.equal(afterSecond.financialSnapshot.outstandingBalance, 0);
  assert.equal(afterSecond.paymentStatus, "fully_paid");

  const workflowAfterSecond = await WorkflowInstanceModel.findOne({ tenantId, entityId: booking._id }).lean();
  assert.equal(workflowAfterSecond.currentState, "confirmed", "reaching fully_paid from reserved must genuinely fire the real Confirm Booking workflow transition");
});

test("BookingPaymentService.markPaid: reaching fully_paid from a workflow state other than reserved is a safe no-op, never a fabricated transition", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const WorkflowInstanceModel = (await import("../models/WorkflowInstanceModel.js")).default;
  const BookingPaymentService = (await import("../services/BookingPaymentService.js")).default;

  const suffix = `bpaynoop-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId });
    await WorkflowInstanceModel.deleteMany({ tenantId });
  });

  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(), status: "deposit_received",
    totalAmount: 500, financialSnapshot: { totalAmount: 500, paidAmount: 0, outstandingBalance: 500, paymentStatus: "unpaid" }
  });
  await WorkflowInstanceModel.create({ tenantId, entityType: "Booking", entityId: booking._id, currentState: "deposit_received", completedSteps: ["draft", "quotation", "reserved", "confirmed", "deposit_received"], history: [] });

  const result = await BookingPaymentService.markPaid({ tenantId, bookingId: booking._id, amountPaid: 500, currency: "USD", stripePaymentIntentId: "pi_test_noop" });
  assert.equal(result.paymentStatus, "fully_paid", "the real financial update must still happen regardless of workflow applicability");

  const workflow = await WorkflowInstanceModel.findOne({ tenantId, entityId: booking._id }).lean();
  assert.equal(workflow.currentState, "deposit_received", "no fabricated transition — this codebase's real config has no single unambiguous action for this state");
});

test("BookingPaymentService.markPaid: absolute tenant isolation — a payment can never be applied to a different tenant's booking", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingPaymentService = (await import("../services/BookingPaymentService.js")).default;

  const suffix = `bpayiso-${Date.now()}`;
  const tenantA = `test-${suffix}-a`;
  const tenantB = `test-${suffix}-b`;

  t.after(async () => { await BookingHeaderModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } }); });

  const booking = await BookingHeaderModel.create({
    tenantId: tenantA, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 200, financialSnapshot: { totalAmount: 200, paidAmount: 0, outstandingBalance: 200, paymentStatus: "unpaid" }
  });

  await assert.rejects(() => BookingPaymentService.markPaid({ tenantId: tenantB, bookingId: booking._id, amountPaid: 200, currency: "USD" }), /not found/i);

  const reloaded = await BookingHeaderModel.findOne({ _id: booking._id }).lean();
  assert.equal(reloaded.financialSnapshot.paidAmount, 0, "tenant B's attempt must leave tenant A's booking completely untouched");
});

test("BookingPaymentService.markRefunded: correct decrement, and Math.max(0, ...) guards against a malformed over-refund", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingPaymentService = (await import("../services/BookingPaymentService.js")).default;

  const suffix = `brefund-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => { await BookingHeaderModel.deleteMany({ tenantId }); });

  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: new mongoose.Types.ObjectId(),
    totalAmount: 300, paidAmount: 300, financialSnapshot: { totalAmount: 300, paidAmount: 300, outstandingBalance: 0, paymentStatus: "fully_paid" }
  });

  const afterPartialRefund = await BookingPaymentService.markRefunded({ tenantId, bookingId: booking._id, refundAmount: 100, stripeChargeId: "ch_test_1" });
  assert.equal(afterPartialRefund.financialSnapshot.refundAmount, 100);
  assert.equal(afterPartialRefund.financialSnapshot.paidAmount, 200);
  assert.equal(afterPartialRefund.paymentStatus, "partially_paid");

  // A malformed/duplicate over-refund must never push paidAmount negative.
  const afterOverRefund = await BookingPaymentService.markRefunded({ tenantId, bookingId: booking._id, refundAmount: 500, stripeChargeId: "ch_test_2" });
  assert.equal(afterOverRefund.financialSnapshot.paidAmount, 0, "paidAmount must clamp at zero, never go negative");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
