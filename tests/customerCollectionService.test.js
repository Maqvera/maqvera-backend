import test from "node:test";
import assert from "node:assert/strict";
import {
  isCollectionCancellable,
  isCollectionDisputable,
  isCollectionWriteOffable,
  isCollectionClosable,
  resolveCollectionStatusAfterPayment,
  addIntervalToDate,
  computeInstallmentSchedule
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
