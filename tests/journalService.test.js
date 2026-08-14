import test from "node:test";
import assert from "node:assert/strict";
import { validateDoubleEntryLines, assertJournalEditable, isPostableStatus, validatePostingRestriction, validateRequiredDimensions, assertRevenueRecognitionJournal, assertCanCorrect, computeJournalDuplicateSignature, computeNextRunDate, deriveApprovalStatus, computeLineBaseCurrencyAmounts, assertCanArchive, assertCanRestore } from "../services/JournalService.js";
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

test("validatePostingRestriction allows everything when Unrestricted or unset", () => {
  assert.doesNotThrow(() => validatePostingRestriction({ accountCode: "1000" }, { journalType: "Manual", currency: "USD" }));
  assert.doesNotThrow(() => validatePostingRestriction({ accountCode: "1000", postingRestriction: { type: "Unrestricted" } }, { journalType: "Manual", currency: "USD" }));
});

test("validatePostingRestriction blocks a Manual posting to a SystemGeneratedOnly account, allows Automatic", () => {
  const account = { accountCode: "2130", postingRestriction: { type: "SystemGeneratedOnly" } };
  assert.throws(() => validatePostingRestriction(account, { journalType: "Manual", currency: "USD" }), /system-generated/);
  assert.doesNotThrow(() => validatePostingRestriction(account, { journalType: "Automatic", currency: "USD" }));
});

test("validatePostingRestriction enforces CurrencyRestricted against the journal's own currency", () => {
  const account = { accountCode: "1130", postingRestriction: { type: "CurrencyRestricted", restrictedCurrencies: ["USD", "AED"] } };
  assert.doesNotThrow(() => validatePostingRestriction(account, { journalType: "Manual", currency: "USD" }));
  assert.throws(() => validatePostingRestriction(account, { journalType: "Manual", currency: "PKR" }), /does not accept postings in PKR/);
});

test("validatePostingRestriction enforces DimensionRestricted against the line's own dimension values", () => {
  const account = { accountCode: "5110", postingRestriction: { type: "DimensionRestricted", restrictedDimensionValues: { department: ["Sales"] } } };
  assert.doesNotThrow(() => validatePostingRestriction(account, { journalType: "Manual", currency: "USD", dimensions: { department: "Sales" } }));
  assert.throws(() => validatePostingRestriction(account, { journalType: "Manual", currency: "USD", dimensions: { department: "Marketing" } }), /restricts dimension "department"/);
  assert.throws(() => validatePostingRestriction(account, { journalType: "Manual", currency: "USD", dimensions: {} }), /restricts dimension "department"/);
});

test("validateRequiredDimensions never blocks an account with no required dimensions configured", () => {
  assert.doesNotThrow(() => validateRequiredDimensions({ accountCode: "1000" }, {}));
});

test("validateRequiredDimensions throws when a required dimension key is missing from the line", () => {
  const account = { accountCode: "5110", dimensions: { required: ["CostCenter"] } };
  assert.throws(() => validateRequiredDimensions(account, {}), /requires the "CostCenter" dimension/);
  assert.doesNotThrow(() => validateRequiredDimensions(account, { costCenter: "CC-1" }));
});

test("assertRevenueRecognitionJournal (File 2 Part 1) is a no-op for every journalType except 'Revenue Recognition'", () => {
  assert.doesNotThrow(() => assertRevenueRecognitionJournal("Manual", []));
  assert.doesNotThrow(() => assertRevenueRecognitionJournal("Automatic", []));
});

test("assertRevenueRecognitionJournal rejects a Revenue Recognition journal with no deferred-revenue-tagged account", () => {
  const accounts = [{ category: "Revenue" }, { category: "Assets" }];
  assert.throws(
    () => assertRevenueRecognitionJournal("Revenue Recognition", accounts),
    /requires at least one line posted to an account with a configured revenueRecognition.deferredRevenueType/
  );
});

test("assertRevenueRecognitionJournal rejects a Revenue Recognition journal with no Revenue-category account", () => {
  const accounts = [{ category: "Liabilities", revenueRecognition: { deferredRevenueType: "Deferred Revenue" } }, { category: "Assets" }];
  assert.throws(
    () => assertRevenueRecognitionJournal("Revenue Recognition", accounts),
    /requires at least one line posted to a Revenue-category account/
  );
});

test("assertRevenueRecognitionJournal allows a real Dr Deferred Revenue / Cr Revenue pair", () => {
  const accounts = [
    { category: "Liabilities", revenueRecognition: { deferredRevenueType: "Deferred Revenue" } },
    { category: "Revenue" }
  ];
  assert.doesNotThrow(() => assertRevenueRecognitionJournal("Revenue Recognition", accounts));
});

test("assertCanCorrect (File 2 Part 2) requires a Posted journal", () => {
  assert.throws(() => assertCanCorrect({ status: "Draft", isCorrected: false }), /Only Posted journals can be corrected/);
});

test("assertCanCorrect blocks correcting an already-corrected journal", () => {
  assert.throws(() => assertCanCorrect({ status: "Posted", isCorrected: true }), /already been corrected/);
});

test("assertCanCorrect allows an ordinary Posted, uncorrected journal", () => {
  assert.doesNotThrow(() => assertCanCorrect({ status: "Posted", isCorrected: false }));
});

test("computeJournalDuplicateSignature is stable regardless of line order", () => {
  const lines1 = [{ accountCode: "1000", debit: 100, credit: 0 }, { accountCode: "4000", debit: 0, credit: 100 }];
  const lines2 = [{ accountCode: "4000", debit: 0, credit: 100 }, { accountCode: "1000", debit: 100, credit: 0 }];
  const sig1 = computeJournalDuplicateSignature(lines1, "2026-08-13", "USD");
  const sig2 = computeJournalDuplicateSignature(lines2, "2026-08-13", "USD");
  assert.equal(sig1, sig2);
});

test("computeJournalDuplicateSignature differs when amounts or currency differ", () => {
  const lines = [{ accountCode: "1000", debit: 100, credit: 0 }, { accountCode: "4000", debit: 0, credit: 100 }];
  const base = computeJournalDuplicateSignature(lines, "2026-08-13", "USD");
  const differentAmount = computeJournalDuplicateSignature([{ accountCode: "1000", debit: 200, credit: 0 }, { accountCode: "4000", debit: 0, credit: 200 }], "2026-08-13", "USD");
  const differentCurrency = computeJournalDuplicateSignature(lines, "2026-08-13", "PKR");
  assert.notEqual(base, differentAmount);
  assert.notEqual(base, differentCurrency);
});

test("computeNextRunDate (Recurring Journals, File 2 Part 2) advances by the named frequency", () => {
  const from = new Date("2026-01-15T00:00:00.000Z");
  assert.equal(computeNextRunDate(from, "Daily").toISOString().slice(0, 10), "2026-01-16");
  assert.equal(computeNextRunDate(from, "Weekly").toISOString().slice(0, 10), "2026-01-22");
  assert.equal(computeNextRunDate(from, "Monthly").toISOString().slice(0, 10), "2026-02-15");
  assert.equal(computeNextRunDate(from, "Quarterly").toISOString().slice(0, 10), "2026-04-15");
  assert.equal(computeNextRunDate(from, "HalfYearly").toISOString().slice(0, 10), "2026-07-15");
  assert.equal(computeNextRunDate(from, "Yearly").toISOString().slice(0, 10), "2027-01-15");
});

test("computeNextRunDate handles Custom intervals and rejects an invalid one", () => {
  const from = new Date("2026-01-15T00:00:00.000Z");
  assert.equal(computeNextRunDate(from, "Custom", 10).toISOString().slice(0, 10), "2026-01-25");
  assert.throws(() => computeNextRunDate(from, "Custom", 0), /customIntervalDays must be a positive number/);
  assert.throws(() => computeNextRunDate(from, "Custom", null), /customIntervalDays must be a positive number/);
});

test("computeNextRunDate rejects an unconfigured frequency", () => {
  assert.throws(() => computeNextRunDate(new Date(), "Fortnightly"), /Invalid recurring journal frequency/);
});

test("deriveApprovalStatus (File 2 Part 3) maps Draft/Pending Approval/Rejected/Cancelled to their own real states", () => {
  assert.equal(deriveApprovalStatus("Draft"), "NotSubmitted");
  assert.equal(deriveApprovalStatus("Pending Approval"), "PendingApproval");
  assert.equal(deriveApprovalStatus("Rejected"), "Rejected");
  assert.equal(deriveApprovalStatus("Cancelled"), "Cancelled");
});

test("deriveApprovalStatus collapses every post-approval state (Approved/Posted/Archived) to Approved", () => {
  assert.equal(deriveApprovalStatus("Approved"), "Approved");
  assert.equal(deriveApprovalStatus("Posted"), "Approved");
  assert.equal(deriveApprovalStatus("Archived"), "Approved");
});

test("computeLineBaseCurrencyAmounts (File 2 Part 4) returns nulls when the exchange rate is 1 (no real conversion happened)", () => {
  assert.deepEqual(computeLineBaseCurrencyAmounts(100, 0, 1), { baseCurrencyDebit: null, baseCurrencyCredit: null });
  assert.deepEqual(computeLineBaseCurrencyAmounts(100, 0, null), { baseCurrencyDebit: null, baseCurrencyCredit: null });
});

test("computeLineBaseCurrencyAmounts converts debit/credit independently at the given rate", () => {
  assert.deepEqual(computeLineBaseCurrencyAmounts(100, 0, 305), { baseCurrencyDebit: 30500, baseCurrencyCredit: 0 });
  assert.deepEqual(computeLineBaseCurrencyAmounts(0, 50, 305), { baseCurrencyDebit: 0, baseCurrencyCredit: 15250 });
});

test("assertCanArchive (File 2 Part 4) only allows a Posted journal to be archived", () => {
  assert.doesNotThrow(() => assertCanArchive({ status: "Posted" }));
  assert.throws(() => assertCanArchive({ status: "Draft" }), /cannot be archived from status "Draft"/);
  assert.throws(() => assertCanArchive({ status: "Archived" }), /cannot be archived from status "Archived"/);
});

test("assertCanRestore only allows an Archived journal to be restored", () => {
  assert.doesNotThrow(() => assertCanRestore({ status: "Archived" }));
  assert.throws(() => assertCanRestore({ status: "Posted" }), /cannot be restored from status "Posted"/);
});
