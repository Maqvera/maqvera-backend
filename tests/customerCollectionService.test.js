import test from "node:test";
import assert from "node:assert/strict";
import {
  isCollectionCancellable,
  isCollectionDisputable,
  isCollectionWriteOffable,
  isCollectionClosable,
  resolveCollectionStatusAfterPayment,
  addIntervalToDate,
  computeInstallmentSchedule,
  sortReceivablesByStrategy,
  buildAllocationPlan,
  computeCustomerRiskScore
} from "../services/CustomerCollectionService.js";

test("collection status predicates follow the Requested -> Partially Collected -> Collected -> Closed gating", () => {
  assert.equal(isCollectionCancellable("Requested"), true);
  assert.equal(isCollectionCancellable("Partially Collected"), true);
  assert.equal(isCollectionCancellable("Collected"), false);

  assert.equal(isCollectionDisputable("Overdue"), true);
  assert.equal(isCollectionDisputable("Closed"), false);

  assert.equal(isCollectionWriteOffable("Requested"), true);
  assert.equal(isCollectionWriteOffable("Collected"), false);
  assert.equal(isCollectionWriteOffable("Written Off"), false);

  assert.equal(isCollectionClosable("Collected"), true);
  assert.equal(isCollectionClosable("Written Off"), true);
  assert.equal(isCollectionClosable("Requested"), false);
});

test("resolveCollectionStatusAfterPayment goes to Collected only once collectedAmount reaches totalAmount", () => {
  assert.equal(resolveCollectionStatusAfterPayment(500, 1000), "Partially Collected");
  assert.equal(resolveCollectionStatusAfterPayment(1000, 1000), "Collected");
  assert.equal(resolveCollectionStatusAfterPayment(1000.001, 1000), "Collected");
});

test("addIntervalToDate rolls Weekly/Quarterly/Monthly correctly", () => {
  assert.equal(addIntervalToDate("2027-01-01", "Weekly").toISOString().slice(0, 10), "2027-01-08");
  assert.equal(addIntervalToDate("2027-01-01", "Quarterly").toISOString().slice(0, 10), "2027-04-01");
  assert.equal(addIntervalToDate("2027-01-01", "Monthly").toISOString().slice(0, 10), "2027-02-01");
  assert.equal(addIntervalToDate("2027-01-01", "Custom").toISOString().slice(0, 10), "2027-02-01"); // Monthly is the fallback cadence for any non Weekly/Quarterly value.
});

test("computeInstallmentSchedule splits evenly with the remainder landing on the last installment", () => {
  const schedule = computeInstallmentSchedule({ totalAmount: 1000, installmentCount: 3, startDate: "2027-01-01", frequency: "Monthly" });
  assert.equal(schedule.length, 3);
  assert.equal(schedule[0].amount, 333.33);
  assert.equal(schedule[1].amount, 333.33);
  assert.equal(schedule[2].amount, 333.34); // remainder absorbed here
  const sum = schedule.reduce((acc, l) => acc + l.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, 1000);
  assert.equal(schedule[0].dueDate.toISOString().slice(0, 10), "2027-01-01");
  assert.equal(schedule[1].dueDate.toISOString().slice(0, 10), "2027-02-01");
  assert.equal(schedule[2].dueDate.toISOString().slice(0, 10), "2027-03-01");
});

test("computeInstallmentSchedule with a Custom frequency uses the caller's own schedule and validates it sums to totalAmount", () => {
  const customSchedule = [
    { dueDate: "2027-01-15", amount: 400 },
    { dueDate: "2027-02-15", amount: 600 }
  ];
  const schedule = computeInstallmentSchedule({ totalAmount: 1000, frequency: "Custom", customSchedule });
  assert.equal(schedule.length, 2);
  assert.equal(schedule[0].amount, 400);
  assert.equal(schedule[1].amount, 600);
  assert.equal(schedule[0].installmentNumber, 1);
});

test("computeInstallmentSchedule rejects a Custom schedule that doesn't sum to totalAmount", () => {
  assert.throws(() => computeInstallmentSchedule({ totalAmount: 1000, frequency: "Custom", customSchedule: [{ dueDate: "2027-01-15", amount: 400 }] }), /sum to exactly/);
});

test("computeInstallmentSchedule rejects a missing/empty Custom schedule", () => {
  assert.throws(() => computeInstallmentSchedule({ totalAmount: 1000, frequency: "Custom" }), /customSchedule is required/);
});

test("sortReceivablesByStrategy orders OldestDueDate by ascending dueDate", () => {
  const receivables = [{ _id: "a", dueDate: "2027-03-01", outstandingBalance: 100 }, { _id: "b", dueDate: "2027-01-01", outstandingBalance: 50 }];
  const sorted = sortReceivablesByStrategy(receivables, "OldestDueDate");
  assert.deepEqual(sorted.map((r) => r._id), ["b", "a"]);
});

test("sortReceivablesByStrategy orders HighestAmountFirst by descending outstandingBalance", () => {
  const receivables = [{ _id: "a", dueDate: "2027-03-01", outstandingBalance: 100 }, { _id: "b", dueDate: "2027-01-01", outstandingBalance: 500 }];
  const sorted = sortReceivablesByStrategy(receivables, "HighestAmountFirst");
  assert.deepEqual(sorted.map((r) => r._id), ["b", "a"]);
});

test("sortReceivablesByStrategy leaves Manual order untouched", () => {
  const receivables = [{ _id: "a", dueDate: "2027-01-01", outstandingBalance: 500 }, { _id: "b", dueDate: "2027-03-01", outstandingBalance: 100 }];
  assert.deepEqual(sortReceivablesByStrategy(receivables, "Manual").map((r) => r._id), ["a", "b"]);
});

test("buildAllocationPlan greedily consumes the unallocated amount across ordered receivables, never exceeding either side", () => {
  const receivables = [{ _id: "a", invoiceNumber: "INV-1", outstandingBalance: 100 }, { _id: "b", invoiceNumber: "INV-2", outstandingBalance: 200 }];
  const { plan, remainingUnallocated } = buildAllocationPlan(250, receivables);
  assert.deepEqual(plan, [{ receivableId: "a", invoiceNumber: "INV-1", amount: 100 }, { receivableId: "b", invoiceNumber: "INV-2", amount: 150 }]);
  assert.equal(remainingUnallocated, 0);
});

test("buildAllocationPlan reports a real remainingUnallocated when receivables don't cover the full amount", () => {
  const receivables = [{ _id: "a", invoiceNumber: "INV-1", outstandingBalance: 50 }];
  const { plan, remainingUnallocated } = buildAllocationPlan(200, receivables);
  assert.deepEqual(plan, [{ receivableId: "a", invoiceNumber: "INV-1", amount: 50 }]);
  assert.equal(remainingUnallocated, 150);
});

test("computeCustomerRiskScore scores a clean customer as Low risk", () => {
  const config = { customerRiskScoreBands: { Low: 25, Medium: 50, High: 75 } };
  const result = computeCustomerRiskScore({ overdueCount: 0, totalCollectionCount: 10, maxDaysOverdue: 0, outstandingBalance: 0, creditLimit: 1000, disputeCount: 0, failedPaymentCount: 0, countryRiskTier: null }, config);
  assert.equal(result.score, 0);
  assert.equal(result.riskCategory, "Low");
  assert.deepEqual(result.flags, []);
});

test("computeCustomerRiskScore combines late payments, aging, credit usage, disputes, and failed payments into a real score", () => {
  const config = { customerRiskScoreBands: { Low: 25, Medium: 50, High: 75 } };
  const result = computeCustomerRiskScore({ overdueCount: 5, totalCollectionCount: 10, maxDaysOverdue: 95, outstandingBalance: 950, creditLimit: 1000, disputeCount: 2, failedPaymentCount: 1, countryRiskTier: "High" }, config);
  // Late: 5/10=0.5 -> 15; Aging: 95>90 -> 20; Credit usage 0.95 -> 20; Disputes: 2*5=10; Failed: 1*5=5; Country High -> 10 = 80
  assert.equal(result.score, 80);
  assert.equal(result.riskCategory, "Critical");
  assert.ok(result.flags.includes("SeverelyAged90Plus"));
});

test("computeCustomerRiskScore caps the score at 100", () => {
  const config = { customerRiskScoreBands: { Low: 25, Medium: 50, High: 75 } };
  const result = computeCustomerRiskScore({ overdueCount: 10, totalCollectionCount: 10, maxDaysOverdue: 200, outstandingBalance: 5000, creditLimit: 1000, disputeCount: 10, failedPaymentCount: 10, countryRiskTier: "High" }, config);
  assert.equal(result.score, 100);
  assert.equal(result.riskCategory, "Critical");
});
