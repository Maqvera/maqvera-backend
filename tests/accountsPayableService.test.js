import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAgingBucket,
  computeOverpaymentSplit,
  resolveStatusAfterPayment,
  isPayableEligibleForPayment,
  isPayableTerminal
} from "../services/AccountsPayableService.js";

const AGING_BUCKETS = [
  { label: "Current", minDays: null, maxDays: 0 },
  { label: "1-30 Days", minDays: 1, maxDays: 30 },
  { label: "31-60 Days", minDays: 31, maxDays: 60 }
];

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

test("AccountsPayableService re-exports the shared aging/allocation helpers", () => {
  // Confirms the utils/agingUtils.js + utils/paymentAllocationUtils.js
  // extraction actually wired both AR and AP to the same implementation.
  const { label } = computeAgingBucket(daysAgo(15), new Date(), AGING_BUCKETS);
  assert.equal(label, "1-30 Days");

  const { appliedToBalance, overpaymentExcess } = computeOverpaymentSplit(120000, 100000);
  assert.equal(appliedToBalance, 100000);
  assert.equal(overpaymentExcess, 20000);

  assert.equal(resolveStatusAfterPayment(60000), "Partially Paid");
  assert.equal(resolveStatusAfterPayment(0), "Paid");
});

test("isPayableEligibleForPayment allows Open and Partially Paid only", () => {
  assert.equal(isPayableEligibleForPayment("Open"), true);
  assert.equal(isPayableEligibleForPayment("Partially Paid"), true);
});

test("isPayableEligibleForPayment rejects Draft/Pending Approval — unlike AR, AP requires approval first", () => {
  assert.equal(isPayableEligibleForPayment("Draft"), false);
  assert.equal(isPayableEligibleForPayment("Pending Approval"), false);
  assert.equal(isPayableEligibleForPayment("Approved"), false);
});

test("isPayableTerminal flags Paid/Settled/Written Off/Cancelled", () => {
  assert.equal(isPayableTerminal("Paid"), true);
  assert.equal(isPayableTerminal("Settled"), true);
  assert.equal(isPayableTerminal("Written Off"), true);
  assert.equal(isPayableTerminal("Cancelled"), true);
});

test("isPayableTerminal allows further action on Open/Partially Paid/Draft", () => {
  assert.equal(isPayableTerminal("Open"), false);
  assert.equal(isPayableTerminal("Partially Paid"), false);
  assert.equal(isPayableTerminal("Draft"), false);
});
