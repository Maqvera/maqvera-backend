import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveGateway,
  computeFraudRiskScore,
  isPaymentAllocatable,
  isPaymentVoidable,
  isPaymentRefundable,
  isPaymentCapturable,
  deriveFraudStatus
} from "../services/PaymentService.js";

test("resolveGateway routes Cash/Cheque/Bank Transfer to Manual regardless of default", () => {
  assert.equal(resolveGateway("Cash", undefined, "Stripe"), "Manual");
  assert.equal(resolveGateway("Cheque", undefined, "Stripe"), "Manual");
  assert.equal(resolveGateway("Bank Transfer", undefined, "Stripe"), "Manual");
});

test("resolveGateway falls back to the configured default for other methods", () => {
  assert.equal(resolveGateway("Credit Card", undefined, "Manual"), "Manual");
  assert.equal(resolveGateway("Credit Card", undefined, "Stripe"), "Stripe");
});

test("resolveGateway always honors an explicitly requested gateway", () => {
  assert.equal(resolveGateway("Cash", "Stripe", "Manual"), "Stripe");
  assert.equal(resolveGateway("Credit Card", "Manual", "Stripe"), "Manual");
});

test("computeFraudRiskScore is zero/clean for an unremarkable payment", () => {
  const { riskScore, flags } = computeFraudRiskScore({ isDuplicate: false, velocityCount: 1, velocityMax: 5, amount: 500, amountThreshold: 1000000 });
  assert.equal(riskScore, 0);
  assert.deepEqual(flags, []);
});

test("computeFraudRiskScore flags a duplicate payment", () => {
  const { riskScore, flags } = computeFraudRiskScore({ isDuplicate: true, velocityCount: 1, velocityMax: 5, amount: 500, amountThreshold: 1000000 });
  assert.equal(riskScore, 40);
  assert.deepEqual(flags, ["DuplicatePayment"]);
});

test("computeFraudRiskScore flags velocity and amount threshold independently", () => {
  const { riskScore, flags } = computeFraudRiskScore({ isDuplicate: false, velocityCount: 10, velocityMax: 5, amount: 2000000, amountThreshold: 1000000 });
  assert.equal(riskScore, 60);
  assert.deepEqual(flags, ["VelocityExceeded", "AmountThresholdExceeded"]);
});

test("computeFraudRiskScore caps the score at 100 even when every signal fires", () => {
  const { riskScore, flags } = computeFraudRiskScore({ isDuplicate: true, velocityCount: 10, velocityMax: 5, amount: 2000000, amountThreshold: 1000000 });
  assert.equal(riskScore, 100);
  assert.equal(flags.length, 3);
});

test("isPaymentAllocatable only allows Captured and Allocated", () => {
  assert.equal(isPaymentAllocatable("Captured"), true);
  assert.equal(isPaymentAllocatable("Allocated"), true);
  assert.equal(isPaymentAllocatable("Initiated"), false);
  assert.equal(isPaymentAllocatable("Voided"), false);
});

test("isPaymentVoidable only allows pre-allocation statuses", () => {
  assert.equal(isPaymentVoidable("Initiated"), true);
  assert.equal(isPaymentVoidable("Authorized"), true);
  assert.equal(isPaymentVoidable("Captured"), true);
  assert.equal(isPaymentVoidable("Allocated"), false);
  assert.equal(isPaymentVoidable("Refunded"), false);
});

test("isPaymentRefundable allows Captured through Completed but not pre-capture statuses", () => {
  assert.equal(isPaymentRefundable("Captured"), true);
  assert.equal(isPaymentRefundable("Allocated"), true);
  assert.equal(isPaymentRefundable("Settled"), true);
  assert.equal(isPaymentRefundable("Completed"), true);
  assert.equal(isPaymentRefundable("Initiated"), false);
  assert.equal(isPaymentRefundable("Voided"), false);
});

test("isPaymentCapturable only allows Authorized (Part 18 Part 3 capture modes)", () => {
  assert.equal(isPaymentCapturable("Authorized"), true);
  assert.equal(isPaymentCapturable("Captured"), false);
  assert.equal(isPaymentCapturable("Initiated"), false);
  assert.equal(isPaymentCapturable("Pending"), false);
});

test("deriveFraudStatus bands riskScore into Clear/Review/Flagged", () => {
  const thresholds = { reviewThreshold: 40, flagThreshold: 70 };
  assert.equal(deriveFraudStatus(0, thresholds), "Clear");
  assert.equal(deriveFraudStatus(39, thresholds), "Clear");
  assert.equal(deriveFraudStatus(40, thresholds), "Review");
  assert.equal(deriveFraudStatus(69, thresholds), "Review");
  assert.equal(deriveFraudStatus(70, thresholds), "Flagged");
  assert.equal(deriveFraudStatus(100, thresholds), "Flagged");
});
