import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRefundEligibility,
  computeRefundRiskScore,
  isRefundApprovalRequired,
  isRefundReviewable,
  isRefundApprovable,
  isRefundRejectable,
  isRefundProcessable,
  isRefundCancellable
} from "../services/RefundService.js";
import { isChargebackResolvable, nextStatusAfterEvidence } from "../services/ChargebackService.js";

test("computeRefundEligibility passes when payment status is refundable and amount is within bounds", () => {
  const result = computeRefundEligibility({ isPaymentStatusEligible: true, remainingRefundableAmount: 500, refundAmount: 200, daysSincePayment: 10, refundWindowDays: 90 });
  assert.equal(result.eligible, true);
  assert.equal(result.withinTimeWindow, true);
  assert.deepEqual(result.reasons, []);
});

test("computeRefundEligibility rejects a non-refundable payment status", () => {
  const result = computeRefundEligibility({ isPaymentStatusEligible: false, remainingRefundableAmount: 500, refundAmount: 200, daysSincePayment: 10, refundWindowDays: 90 });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes("not in a refundable status")));
});

test("computeRefundEligibility rejects an amount exceeding the remaining refundable amount", () => {
  const result = computeRefundEligibility({ isPaymentStatusEligible: true, remainingRefundableAmount: 100, refundAmount: 200, daysSincePayment: 10, refundWindowDays: 90 });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes("exceeds the remaining refundable amount")));
});

test("computeRefundEligibility rejects a request outside the configured time window", () => {
  const result = computeRefundEligibility({ isPaymentStatusEligible: true, remainingRefundableAmount: 500, refundAmount: 200, daysSincePayment: 120, refundWindowDays: 90 });
  assert.equal(result.eligible, false);
  assert.equal(result.withinTimeWindow, false);
});

test("computeRefundEligibility treats refundWindowDays=0 as unlimited", () => {
  const result = computeRefundEligibility({ isPaymentStatusEligible: true, remainingRefundableAmount: 500, refundAmount: 200, daysSincePayment: 9999, refundWindowDays: 0 });
  assert.equal(result.eligible, true);
  assert.equal(result.withinTimeWindow, true);
});

test("computeRefundRiskScore flags duplicate, velocity, and amount signals independently", () => {
  const clean = computeRefundRiskScore({ isDuplicate: false, velocityCount: 1, velocityMax: 5, amount: 100, amountThreshold: 1000000 });
  assert.equal(clean.riskScore, 0);
  assert.deepEqual(clean.flags, []);

  const risky = computeRefundRiskScore({ isDuplicate: true, velocityCount: 10, velocityMax: 5, amount: 2000000, amountThreshold: 1000000 });
  assert.equal(risky.riskScore, 100);
  assert.deepEqual(risky.flags, ["DuplicateRefund", "HighRefundFrequency", "HighAmount"]);
});

test("isRefundApprovalRequired honors both the boolean gate and the amount threshold", () => {
  assert.equal(isRefundApprovalRequired(50, { refundApprovalRequired: true, refundApprovalAmountThreshold: 0 }), true);
  assert.equal(isRefundApprovalRequired(50, { refundApprovalRequired: false, refundApprovalAmountThreshold: 0 }), false);
  assert.equal(isRefundApprovalRequired(5000, { refundApprovalRequired: false, refundApprovalAmountThreshold: 1000 }), true);
  assert.equal(isRefundApprovalRequired(500, { refundApprovalRequired: false, refundApprovalAmountThreshold: 1000 }), false);
});

test("refund status predicates follow the Requested -> Under Review -> Approved -> Processing -> Completed gating", () => {
  assert.equal(isRefundReviewable("Requested"), true);
  assert.equal(isRefundReviewable("Under Review"), false);

  assert.equal(isRefundApprovable("Requested"), true);
  assert.equal(isRefundApprovable("Under Review"), true);
  assert.equal(isRefundApprovable("Approved"), false);

  assert.equal(isRefundRejectable("Requested"), true);
  assert.equal(isRefundRejectable("Approved"), false);

  assert.equal(isRefundProcessable("Approved"), true);
  assert.equal(isRefundProcessable("Requested"), false);

  assert.equal(isRefundCancellable("Requested"), true);
  assert.equal(isRefundCancellable("Approved"), true);
  assert.equal(isRefundCancellable("Processing"), false);
});

test("chargeback status predicates and evidence-resubmission-as-appeal", () => {
  assert.equal(isChargebackResolvable("Open"), true);
  assert.equal(isChargebackResolvable("Evidence Submitted"), true);
  assert.equal(isChargebackResolvable("Won"), false);
  assert.equal(isChargebackResolvable("Lost"), false);

  assert.equal(nextStatusAfterEvidence("Open"), "Evidence Submitted");
  assert.equal(nextStatusAfterEvidence("Evidence Submitted"), "Under Appeal");
  assert.equal(nextStatusAfterEvidence("Under Appeal"), "Under Appeal");
});
