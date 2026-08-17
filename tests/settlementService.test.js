import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSettlementFees,
  computeNetAmount,
  isSettlementCancellable,
  isSettlementReversible,
  isSettlementAdjustable,
  isSettlementCompletable
} from "../services/SettlementService.js";

const schedule = {
  Default: { GatewayFee: { percent: 2.9, fixed: 0.30 } },
  Stripe: { GatewayFee: { percent: 2.9, fixed: 0.30 }, ProcessingFee: { percent: 0.5, fixed: 0 } }
};

test("computeSettlementFees applies the gateway's own configured percent+fixed schedule", () => {
  const result = computeSettlementFees(1000, "Stripe", schedule);
  assert.deepEqual(result.fees, [
    { feeType: "GatewayFee", amount: 29.3 },
    { feeType: "ProcessingFee", amount: 5 }
  ]);
  assert.equal(result.feeTotal, 34.3);
});

test("computeSettlementFees falls back to the Default schedule for an unconfigured gateway", () => {
  const result = computeSettlementFees(1000, "SomeOtherGateway", schedule);
  assert.deepEqual(result.fees, [{ feeType: "GatewayFee", amount: 29.3 }]);
});

test("computeSettlementFees omits a zero-amount fee line rather than recording a no-op entry", () => {
  const zeroSchedule = { Default: { ProcessingFee: { percent: 0, fixed: 0 } } };
  const result = computeSettlementFees(1000, "Default", zeroSchedule);
  assert.deepEqual(result.fees, []);
  assert.equal(result.feeTotal, 0);
});

test("computeNetAmount subtracts fees and applies a positive or negative FX adjustment", () => {
  assert.equal(computeNetAmount(1000, 29.3, 0), 970.7);
  assert.equal(computeNetAmount(1000, 29.3, 5.5), 976.2);
  assert.equal(computeNetAmount(1000, 29.3, -5.5), 965.2);
});

test("settlement status predicates follow the Pending -> Sent -> Processing -> Completed gating", () => {
  assert.equal(isSettlementCancellable("Pending"), true);
  assert.equal(isSettlementCancellable("Sent"), false);

  assert.equal(isSettlementReversible("Completed"), true);
  assert.equal(isSettlementReversible("Pending"), false);

  assert.equal(isSettlementCompletable("Sent"), true);
  assert.equal(isSettlementCompletable("Processing"), true);
  assert.equal(isSettlementCompletable("Pending"), false);
});

test("isSettlementAdjustable allows every status except the three genuine dead ends", () => {
  assert.equal(isSettlementAdjustable("Pending"), true);
  assert.equal(isSettlementAdjustable("Completed"), true);
  assert.equal(isSettlementAdjustable("Disputed"), true);
  assert.equal(isSettlementAdjustable("Failed"), false);
  assert.equal(isSettlementAdjustable("Reversed"), false);
  assert.equal(isSettlementAdjustable("Cancelled"), false);
});
