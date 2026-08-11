import test from "node:test";
import assert from "node:assert/strict";
import {
  computePerDiemAmount,
  computeMileageAmount,
  computeRequiredApprovalLevels,
  checkPolicyViolations,
  doesPeriodContainDate,
  isExpenseEditable,
  isExpenseSubmittable,
  isExpenseApprovable,
  isExpenseRejectable,
  isExpenseReturnable,
  isExpenseCancellable,
  isExpenseReimbursable,
  isExpenseCloseable,
  isReceiptUploadable
} from "../services/ExpenseService.js";

const CONFIG = {
  perDiemRatesByCountry: { USA: 75, Default: 50 },
  mileageRatesByVehicleType: { Car: 0.5, Motorcycle: 0.25 },
  expenseApprovalThresholdFinance: 500,
  expenseApprovalThresholdCFO: 5000,
  expenseMaxAmountPerCategory: { Meals: 100 },
  expenseReceiptRequiredAboveAmount: 25
};

test("computePerDiemAmount uses the country-specific rate when configured", () => {
  assert.equal(computePerDiemAmount("USA", 3, CONFIG), 225);
});

test("computePerDiemAmount falls back to Default when the country has no specific rate", () => {
  assert.equal(computePerDiemAmount("Elbonia", 2, CONFIG), 100);
});

test("computePerDiemAmount rejects non-positive days", () => {
  assert.throws(() => computePerDiemAmount("USA", 0, CONFIG), /greater than zero/);
});

test("computeMileageAmount multiplies distance by the vehicle's configured rate", () => {
  assert.equal(computeMileageAmount(100, "Car", CONFIG), 50);
  assert.equal(computeMileageAmount(100, "Motorcycle", CONFIG), 25);
});

test("computeMileageAmount rejects an unconfigured vehicle type", () => {
  assert.throws(() => computeMileageAmount(100, "Helicopter", CONFIG), /No mileage rate configured/);
});

test("computeRequiredApprovalLevels always includes Manager and adds tiers by amount", () => {
  assert.deepEqual(computeRequiredApprovalLevels(100, CONFIG), ["Manager"]);
  assert.deepEqual(computeRequiredApprovalLevels(500, CONFIG), ["Manager", "Finance"]);
  assert.deepEqual(computeRequiredApprovalLevels(5000, CONFIG), ["Manager", "Finance", "CFO"]);
});

test("computeRequiredApprovalLevels treats a 0 threshold as that tier never required", () => {
  const config = { ...CONFIG, expenseApprovalThresholdCFO: 0 };
  assert.deepEqual(computeRequiredApprovalLevels(999999, config), ["Manager", "Finance"]);
});

test("checkPolicyViolations flags an amount over the category cap", () => {
  const violations = checkPolicyViolations({ category: "Meals", amount: 150, hasReceipt: true, config: CONFIG });
  assert.deepEqual(violations, ["AmountExceedsCategoryLimit"]);
});

test("checkPolicyViolations flags a missing receipt above the threshold", () => {
  const violations = checkPolicyViolations({ category: "Travel", amount: 50, hasReceipt: false, config: CONFIG });
  assert.deepEqual(violations, ["ReceiptMissingAboveThreshold"]);
});

test("checkPolicyViolations returns empty when compliant", () => {
  const violations = checkPolicyViolations({ category: "Travel", amount: 10, hasReceipt: false, config: CONFIG });
  assert.deepEqual(violations, []);
});

test("doesPeriodContainDate matches a bare year or a year-month against a date", () => {
  assert.equal(doesPeriodContainDate("2027", new Date("2027-04-15")), true);
  assert.equal(doesPeriodContainDate("2027-04", new Date("2027-04-15")), true);
  assert.equal(doesPeriodContainDate("2027-05", new Date("2027-04-15")), false);
  assert.equal(doesPeriodContainDate("2026", new Date("2027-04-15")), false);
});

test("expense status predicates follow the Draft -> Submitted -> Under Review -> Approved -> Reimbursed -> Closed gating", () => {
  assert.equal(isExpenseEditable("Draft"), true);
  assert.equal(isExpenseEditable("Returned"), true);
  assert.equal(isExpenseEditable("Submitted"), false);

  assert.equal(isExpenseSubmittable("Draft"), true);
  assert.equal(isExpenseSubmittable("Under Review"), false);

  assert.equal(isExpenseApprovable("Under Review"), true);
  assert.equal(isExpenseApprovable("Submitted"), false);

  assert.equal(isExpenseRejectable("Submitted"), true);
  assert.equal(isExpenseRejectable("Under Review"), true);
  assert.equal(isExpenseRejectable("Approved"), false);

  assert.equal(isExpenseReturnable("Under Review"), true);
  assert.equal(isExpenseReturnable("Draft"), false);

  assert.equal(isExpenseCancellable("Draft"), true);
  assert.equal(isExpenseCancellable("Approved"), false);

  assert.equal(isExpenseReimbursable("Approved"), true);
  assert.equal(isExpenseReimbursable("Under Review"), false);

  assert.equal(isExpenseCloseable("Reimbursed"), true);
  assert.equal(isExpenseCloseable("Approved"), false);

  assert.equal(isReceiptUploadable("Draft"), true);
  assert.equal(isReceiptUploadable("Under Review"), true);
  assert.equal(isReceiptUploadable("Closed"), false);
  assert.equal(isReceiptUploadable("Rejected"), false);
});
