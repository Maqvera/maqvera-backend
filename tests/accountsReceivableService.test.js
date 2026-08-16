import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAgingBucket,
  computeOverpaymentSplit,
  resolveStatusAfterPayment,
  assertWithinCreditLimit
} from "../services/AccountsReceivableService.js";

const AGING_BUCKETS = [
  { label: "Current", minDays: null, maxDays: 0 },
  { label: "1-30 Days", minDays: 1, maxDays: 30 },
  { label: "31-60 Days", minDays: 31, maxDays: 60 },
  { label: "61-90 Days", minDays: 61, maxDays: 90 },
  { label: "91-120 Days", minDays: 91, maxDays: 120 },
  { label: "120+ Days", minDays: 121, maxDays: null }
];

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const daysAhead = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

test("computeAgingBucket buckets a not-yet-due receivable as Current", () => {
  const { label, daysOverdue } = computeAgingBucket(daysAhead(5), new Date(), AGING_BUCKETS);
  assert.equal(label, "Current");
  assert.ok(daysOverdue < 0);
});

test("computeAgingBucket buckets a receivable due today as Current", () => {
  const { label } = computeAgingBucket(new Date(), new Date(), AGING_BUCKETS);
  assert.equal(label, "Current");
});

test("computeAgingBucket places 15 days overdue in the 1-30 Days bucket", () => {
  const { label, daysOverdue } = computeAgingBucket(daysAgo(15), new Date(), AGING_BUCKETS);
  assert.equal(label, "1-30 Days");
  assert.equal(daysOverdue, 15);
});

test("computeAgingBucket places 45 days overdue in the 31-60 Days bucket", () => {
  const { label } = computeAgingBucket(daysAgo(45), new Date(), AGING_BUCKETS);
  assert.equal(label, "31-60 Days");
});

test("computeAgingBucket places 200 days overdue in the 120+ Days bucket", () => {
  const { label } = computeAgingBucket(daysAgo(200), new Date(), AGING_BUCKETS);
  assert.equal(label, "120+ Days");
});

test("computeOverpaymentSplit applies the full amount when it doesn't exceed the outstanding balance", () => {
  const { appliedToBalance, overpaymentExcess } = computeOverpaymentSplit(4000, 10000);
  assert.equal(appliedToBalance, 4000);
  assert.equal(overpaymentExcess, 0);
});

test("computeOverpaymentSplit caps the applied amount and surfaces the excess as overpayment", () => {
  // Matches the spec's own worked example: Invoice 10,000, Payment 12,000 -> Outstanding 0, Customer Credit 2,000.
  const { appliedToBalance, overpaymentExcess } = computeOverpaymentSplit(12000, 10000);
  assert.equal(appliedToBalance, 10000);
  assert.equal(overpaymentExcess, 2000);
});

test("resolveStatusAfterPayment returns Paid once the balance reaches zero", () => {
  assert.equal(resolveStatusAfterPayment(0), "Paid");
  assert.equal(resolveStatusAfterPayment(-0.001), "Paid");
});

test("resolveStatusAfterPayment returns Partially Paid while a balance remains", () => {
  assert.equal(resolveStatusAfterPayment(6000), "Partially Paid");
});

test("assertWithinCreditLimit allows an unconfigured (zero) limit through unchecked", () => {
  assert.doesNotThrow(() => assertWithinCreditLimit(0, 999999, 500));
});

test("assertWithinCreditLimit blocks a receivable that would exceed a configured limit", () => {
  assert.throws(() => assertWithinCreditLimit(5000, 4800, 500), /Credit limit exceeded/);
});

test("assertWithinCreditLimit allows a receivable that stays within a configured limit", () => {
  assert.doesNotThrow(() => assertWithinCreditLimit(5000, 4000, 500));
});

test("assertWithinCreditLimit is skipped entirely when enforcement is disabled", () => {
  assert.doesNotThrow(() => assertWithinCreditLimit(1000, 999999, 500, false));
});
