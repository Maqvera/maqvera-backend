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
  isReceiptUploadable,
  deriveApprovalStatus,
  deriveBudgetStatus,
  deriveAccountingStatus,
  computeFraudRiskScore,
  validateAllocations,
  computeAllocationAmounts
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
  // Part 35 — an Approved-but-not-yet-Reimbursed expense is now
  // cancellable (real, automatic budget rollback + accrual-journal
  // reversal; see cancelExpense). Reimbursed/Closed stay terminal.
  assert.equal(isExpenseCancellable("Approved"), true);
  assert.equal(isExpenseCancellable("Reimbursed"), false);
  assert.equal(isExpenseCancellable("Closed"), false);

  assert.equal(isExpenseReimbursable("Approved"), true);
  assert.equal(isExpenseReimbursable("Under Review"), false);

  assert.equal(isExpenseCloseable("Reimbursed"), true);
  assert.equal(isExpenseCloseable("Approved"), false);

  assert.equal(isReceiptUploadable("Draft"), true);
  assert.equal(isReceiptUploadable("Under Review"), true);
  assert.equal(isReceiptUploadable("Closed"), false);
  assert.equal(isReceiptUploadable("Rejected"), false);
});

test("deriveApprovalStatus maps the real lifecycle status onto the spec's own Approval Status vocabulary", () => {
  assert.equal(deriveApprovalStatus("Draft"), "NotSubmitted");
  assert.equal(deriveApprovalStatus("Returned"), "NotSubmitted");
  assert.equal(deriveApprovalStatus("Under Review"), "PendingApproval");
  assert.equal(deriveApprovalStatus("Approved"), "Approved");
  assert.equal(deriveApprovalStatus("Reimbursed"), "Approved");
  assert.equal(deriveApprovalStatus("Closed"), "Approved");
  assert.equal(deriveApprovalStatus("Rejected"), "Rejected");
});

test("deriveBudgetStatus reads the real budgetCheck sub-document, never a fabricated separate flag", () => {
  assert.equal(deriveBudgetStatus(null), "NotChecked");
  assert.equal(deriveBudgetStatus({ checkedAt: null }), "NotChecked");
  assert.equal(deriveBudgetStatus({ checkedAt: new Date(), exceeded: true }), "Exceeded");
  assert.equal(deriveBudgetStatus({ checkedAt: new Date(), exceeded: false }), "WithinBudget");
});

test("deriveAccountingStatus is Posted only when a real journalId exists, never silently claimed otherwise", () => {
  assert.equal(deriveAccountingStatus({ status: "Draft", reimbursement: {} }), "NotPosted");
  assert.equal(deriveAccountingStatus({ status: "Reimbursed", reimbursement: {} }), "ReimbursedNotPosted");
  assert.equal(deriveAccountingStatus({ status: "Reimbursed", reimbursement: { journalId: "abc" } }), "Posted");
  assert.equal(deriveAccountingStatus({ status: "Closed", reimbursement: { journalId: "abc" } }), "Posted");
  assert.equal(deriveAccountingStatus({ status: "Approved", accrual: { journalId: "abc" }, reimbursement: {} }), "Posted");
});

test("computeFraudRiskScore flags a duplicate checksum, an OCR/claimed amount mismatch, and a category-cap breach independently, capped at 100", () => {
  assert.deepEqual(computeFraudRiskScore({ isDuplicate: false, ocrAmount: null, claimedAmount: 100 }), { score: 0, flags: [] });
  assert.deepEqual(computeFraudRiskScore({ isDuplicate: true, ocrAmount: null, claimedAmount: 100 }), { score: 50, flags: ["DuplicateReceiptChecksum"] });
  assert.deepEqual(computeFraudRiskScore({ isDuplicate: false, ocrAmount: 150, claimedAmount: 100 }), { score: 25, flags: ["OcrAmountMismatch"] });
  assert.deepEqual(computeFraudRiskScore({ isDuplicate: false, ocrAmount: 105, claimedAmount: 100 }), { score: 0, flags: [] });
  assert.deepEqual(computeFraudRiskScore({ isDuplicate: false, ocrAmount: null, claimedAmount: 150, categoryCap: 100 }), { score: 25, flags: ["AmountExceedsCategoryLimit"] });
  const all = computeFraudRiskScore({ isDuplicate: true, ocrAmount: 300, claimedAmount: 100, categoryCap: 50 });
  assert.equal(all.score, 100);
  assert.deepEqual(all.flags.sort(), ["AmountExceedsCategoryLimit", "DuplicateReceiptChecksum", "OcrAmountMismatch"].sort());
});

test("validateAllocations requires percentages to total exactly 100% and each allocation to name a real target", () => {
  assert.doesNotThrow(() => validateAllocations([], 500));
  assert.doesNotThrow(() => validateAllocations(null, 500));
  assert.doesNotThrow(() => validateAllocations([{ costCenter: "CC-1", percentage: 40 }, { projectId: "P-1", percentage: 60 }], 500));
  assert.throws(() => validateAllocations([{ costCenter: "CC-1", percentage: 40 }, { projectId: "P-1", percentage: 50 }], 500), /must total 100%/);
  assert.throws(() => validateAllocations([{ percentage: 100 }], 500), /at least one target/);
});

test("computeAllocationAmounts derives each allocation's real amount from its percentage of the expense total", () => {
  const result = computeAllocationAmounts([{ costCenter: "Marketing", percentage: 40 }, { costCenter: "Sales", percentage: 35 }, { costCenter: "Operations", percentage: 25 }], 1000);
  assert.deepEqual(result.map((r) => r.amount), [400, 350, 250]);
  assert.deepEqual(computeAllocationAmounts([], 1000), []);
});
