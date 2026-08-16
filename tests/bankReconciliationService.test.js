import test from "node:test";
import assert from "node:assert/strict";
import {
  computeReferenceSimilarity,
  normalizeMatchWeights,
  computeMatchScore,
  isDuplicateStatementLine,
  isReconciliationApprovable,
  isReconciliationCompletable,
  isReconciliationRejectable,
  isReconciliationReopenable,
  isReconciliationArchivable,
  isReconciliationMatchable
} from "../services/BankReconciliationService.js";

const CONFIG = {
  reconciliationAmountTolerance: 1,
  reconciliationDateToleranceDays: 3,
  reconciliationMatchWeights: { amount: 0.5, date: 0.3, reference: 0.2 }
};

test("computeReferenceSimilarity returns 1 for identical strings and 0 for empty input", () => {
  assert.equal(computeReferenceSimilarity("Cheque 001", "Cheque 001"), 1);
  assert.equal(computeReferenceSimilarity("", "Cheque 001"), 0);
  assert.equal(computeReferenceSimilarity(null, null), 0);
});

test("computeReferenceSimilarity scores near matches higher than unrelated strings", () => {
  const near = computeReferenceSimilarity("Cheque 001 cleared", "Cheque 001 clear");
  const unrelated = computeReferenceSimilarity("Cheque 001 cleared", "Salary payment April");
  assert.ok(near > 0.8, `expected near match > 0.8, got ${near}`);
  assert.ok(unrelated < near);
});

test("normalizeMatchWeights normalizes an override that doesn't sum to 1", () => {
  const weights = normalizeMatchWeights({ amount: 1, date: 1, reference: 0 });
  assert.equal(weights.amount, 0.5);
  assert.equal(weights.date, 0.5);
  assert.equal(weights.reference, 0);
});

test("normalizeMatchWeights falls back to the default split when given nothing", () => {
  const weights = normalizeMatchWeights({});
  assert.equal(weights.amount, 0.5);
  assert.equal(weights.date, 0.3);
  assert.equal(weights.reference, 0.2);
});

test("computeMatchScore hard-blocks a direction mismatch regardless of everything else", () => {
  const statementTxn = { direction: "Debit", currency: "PKR", amount: 1500, transactionDate: new Date("2027-01-05"), reference: "Cheque 001" };
  const erpTxn = { direction: "Credit", currency: "PKR", amount: 1500, date: new Date("2027-01-05"), description: "Cheque 001" };
  const result = computeMatchScore({ statementTxn, erpTxn, config: CONFIG });
  assert.equal(result.score, 0);
  assert.equal(result.eligible, false);
});

test("computeMatchScore hard-blocks a currency mismatch", () => {
  const statementTxn = { direction: "Debit", currency: "PKR", amount: 1500, transactionDate: new Date("2027-01-05"), reference: "Cheque 001" };
  const erpTxn = { direction: "Debit", currency: "USD", amount: 1500, date: new Date("2027-01-05"), description: "Cheque 001" };
  const result = computeMatchScore({ statementTxn, erpTxn, config: CONFIG });
  assert.equal(result.score, 0);
  assert.equal(result.eligible, false);
});

test("computeMatchScore scores a perfect match at 100", () => {
  const statementTxn = { direction: "Debit", currency: "PKR", amount: 1500, transactionDate: new Date("2027-01-05"), reference: "Cheque 001 cleared" };
  const erpTxn = { direction: "Debit", currency: "PKR", amount: 1500, date: new Date("2027-01-05"), description: "Cheque 001 cleared" };
  const result = computeMatchScore({ statementTxn, erpTxn, config: CONFIG });
  assert.equal(result.score, 100);
  assert.equal(result.eligible, true);
});

test("computeMatchScore degrades score as amount/date drift beyond exact but within tolerance", () => {
  const statementTxn = { direction: "Credit", currency: "PKR", amount: 5000, transactionDate: new Date("2027-01-10"), reference: "Customer deposit" };
  const erpTxnClose = { direction: "Credit", currency: "PKR", amount: 5000.5, date: new Date("2027-01-11"), description: "Customer deposit" };
  const erpTxnFar = { direction: "Credit", currency: "PKR", amount: 5000.5, date: new Date("2027-01-20"), description: "Unrelated narrative text" };
  const closeResult = computeMatchScore({ statementTxn, erpTxn: erpTxnClose, config: CONFIG });
  const farResult = computeMatchScore({ statementTxn, erpTxn: erpTxnFar, config: CONFIG });
  assert.ok(closeResult.score > farResult.score);
  assert.ok(closeResult.score < 100);
});

test("isDuplicateStatementLine flags identical shape and rejects differing amounts", () => {
  const a = { direction: "Debit", currency: "PKR", amount: 1500, transactionDate: new Date("2027-01-05"), reference: "Cheque 001" };
  const b = { direction: "Debit", currency: "PKR", amount: 1500, transactionDate: new Date("2027-01-05"), reference: "cheque 001" };
  const c = { direction: "Debit", currency: "PKR", amount: 1600, transactionDate: new Date("2027-01-05"), reference: "Cheque 001" };
  assert.equal(isDuplicateStatementLine(a, b), true);
  assert.equal(isDuplicateStatementLine(a, c), false);
});

test("reconciliation status predicates follow the Manual Review -> Approved -> Completed gating", () => {
  assert.equal(isReconciliationMatchable("Manual Review"), true);
  assert.equal(isReconciliationMatchable("Approved"), false);

  assert.equal(isReconciliationApprovable("Manual Review"), true);
  assert.equal(isReconciliationApprovable("Approved"), false);

  assert.equal(isReconciliationCompletable("Approved"), true);
  assert.equal(isReconciliationCompletable("Manual Review"), false);

  assert.equal(isReconciliationRejectable("Manual Review"), true);
  assert.equal(isReconciliationRejectable("Approved"), true);
  assert.equal(isReconciliationRejectable("Completed"), false);

  assert.equal(isReconciliationReopenable("Approved"), true);
  assert.equal(isReconciliationReopenable("Completed"), true);
  assert.equal(isReconciliationReopenable("Manual Review"), false);

  assert.equal(isReconciliationArchivable("Completed"), true);
  assert.equal(isReconciliationArchivable("Rejected"), true);
  assert.equal(isReconciliationArchivable("Approved"), false);
});
