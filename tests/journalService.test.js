import test from "node:test";
import assert from "node:assert/strict";
import { validateDoubleEntryLines, assertJournalEditable, isPostableStatus } from "../services/JournalService.js";
import { computeRunningBalance, normalizeBalanceForCategory, assertLinesBalance, DEBIT_NORMAL_CATEGORIES } from "../services/LedgerService.js";
import { periodBlocksPosting } from "../services/FinancialPeriodService.js";

test("validateDoubleEntryLines accepts a balanced journal and returns totals", () => {
  const { debitTotal, creditTotal } = validateDoubleEntryLines([
    { debit: 5000, credit: 0 },
    { debit: 0, credit: 5000 }
  ]);
  assert.equal(debitTotal, 5000);
  assert.equal(creditTotal, 5000);
});

test("validateDoubleEntryLines rejects an out-of-balance journal", () => {
  assert.throws(
    () => validateDoubleEntryLines([{ debit: 5000, credit: 0 }, { debit: 0, credit: 4000 }]),
    /out of balance/
  );
});

test("validateDoubleEntryLines rejects a line with both debit and credit", () => {
  assert.throws(
    () => validateDoubleEntryLines([{ debit: 100, credit: 100 }, { debit: 0, credit: 100 }]),
    /cannot have both/
  );
});

test("validateDoubleEntryLines rejects a line with neither debit nor credit", () => {
  assert.throws(
    () => validateDoubleEntryLines([{ debit: 0, credit: 0 }, { debit: 100, credit: 0 }]),
    /must have either/
  );
});

test("validateDoubleEntryLines rejects fewer than two lines", () => {
  assert.throws(() => validateDoubleEntryLines([{ debit: 100, credit: 0 }]), /at least two lines/);
});

test("validateDoubleEntryLines rejects an all-zero journal", () => {
  assert.throws(
    () => validateDoubleEntryLines([{ debit: 0, credit: 0 }, { debit: 0, credit: 0 }]),
    /must have either/
  );
});

test("validateDoubleEntryLines tolerates floating point rounding", () => {
  const { debitTotal, creditTotal } = validateDoubleEntryLines([
    { debit: 0.1, credit: 0 },
    { debit: 0.2, credit: 0 },
    { debit: 0, credit: 0.3 }
  ]);
  assert.equal(debitTotal, 0.3);
  assert.equal(creditTotal, 0.3);
});

test("assertJournalEditable allows Draft and blocks everything else", () => {
  assert.doesNotThrow(() => assertJournalEditable({ status: "Draft" }));
  assert.throws(() => assertJournalEditable({ status: "Posted" }), /Only Draft journals/);
  assert.throws(() => assertJournalEditable({ status: "Approved" }), /Only Draft journals/);
});

test("isPostableStatus requires Approved when approval is required", () => {
  assert.equal(isPostableStatus("Approved", true), true);
  assert.equal(isPostableStatus("Draft", true), false);
  assert.equal(isPostableStatus("Pending Approval", true), false);
});

test("isPostableStatus allows Draft or Approved when approval is not required", () => {
  assert.equal(isPostableStatus("Draft", false), true);
  assert.equal(isPostableStatus("Approved", false), true);
  assert.equal(isPostableStatus("Rejected", false), false);
});

test("computeRunningBalance accumulates signed debit-minus-credit movement", () => {
  assert.equal(computeRunningBalance(0, 100, 0), 100);
  assert.equal(computeRunningBalance(100, 0, 40), 60);
  assert.equal(computeRunningBalance(60, 25, 0), 85);
});

test("normalizeBalanceForCategory presents a debit-normal category as a debit balance", () => {
  assert.ok(DEBIT_NORMAL_CATEGORIES.has("Assets"));
  const { debitBalance, creditBalance, netBalance } = normalizeBalanceForCategory("Assets", 500);
  assert.equal(debitBalance, 500);
  assert.equal(creditBalance, 0);
  assert.equal(netBalance, 500);
});

test("normalizeBalanceForCategory flips sign for a credit-normal category", () => {
  assert.ok(!DEBIT_NORMAL_CATEGORIES.has("Liabilities"));
  // A Liability account with net debit-minus-credit of -500 (i.e. more
  // credits posted) is a normal 500 credit balance.
  const { debitBalance, creditBalance } = normalizeBalanceForCategory("Liabilities", -500);
  assert.equal(debitBalance, 0);
  assert.equal(creditBalance, 500);
});

test("normalizeBalanceForCategory flags an abnormal balance without hiding it", () => {
  // A Liability account with a positive raw balance (net debit) is unusual
  // but must still surface as a debit balance, not be silently clamped.
  const { debitBalance, creditBalance } = normalizeBalanceForCategory("Liabilities", 200);
  assert.equal(debitBalance, 200);
  assert.equal(creditBalance, 0);
});

test("periodBlocksPosting is permissive when no period record exists", () => {
  assert.equal(periodBlocksPosting(null), false);
  assert.equal(periodBlocksPosting(undefined), false);
});

test("periodBlocksPosting blocks Closed and Locked periods, allows Open", () => {
  assert.equal(periodBlocksPosting({ status: "Open" }), false);
  assert.equal(periodBlocksPosting({ status: "Closed" }), true);
  assert.equal(periodBlocksPosting({ status: "Locked" }), true);
});

test("assertLinesBalance accepts a balanced set of journal lines", () => {
  assert.doesNotThrow(() => assertLinesBalance([{ debit: 5000, credit: 0 }, { debit: 0, credit: 5000 }]));
});

test("assertLinesBalance rejects an out-of-balance posting at the ledger layer independently of the journal layer", () => {
  assert.throws(
    () => assertLinesBalance([{ debit: 5000, credit: 0 }, { debit: 0, credit: 4000 }]),
    /Out-of-balance posting rejected/
  );
});
