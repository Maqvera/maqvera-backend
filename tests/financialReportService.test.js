import test from "node:test";
import assert from "node:assert/strict";
import {
  isReportArchivable,
  groupRowsForBalanceSheet,
  groupRowsForProfitAndLoss,
  computeRetainedEarnings,
  summarizeAging,
  computeBudgetVariance,
  summarizeCashFlow
} from "../services/FinancialReportService.js";
import { flattenReportRows } from "../services/FinancialReportExportService.js";

test("isReportArchivable only allows a Generated report", () => {
  assert.equal(isReportArchivable("Generated"), true);
  assert.equal(isReportArchivable("Archived"), false);
  assert.equal(isReportArchivable("Cancelled"), false);
});

test("groupRowsForBalanceSheet sections real trial-balance rows into Assets/Liabilities/Equity and checks Assets = Liabilities + Equity", () => {
  const rows = [
    { category: "Assets", accountCode: "1000", netBalance: 5000 },
    { category: "Liabilities", accountCode: "2000", netBalance: 2000 },
    { category: "Equity", accountCode: "3000", netBalance: 3000 },
    { category: "Revenue", accountCode: "4000", netBalance: 9999 } // Revenue never appears on a balance sheet — must be ignored.
  ];
  const result = groupRowsForBalanceSheet(rows);
  assert.equal(result.totalAssets, 5000);
  assert.equal(result.totalLiabilities, 2000);
  assert.equal(result.totalEquity, 3000);
  assert.equal(result.isBalanced, true);
  assert.equal(result.sections.Assets.length, 1);
  assert.equal(result.sections.Revenue, undefined);
});

test("groupRowsForBalanceSheet flags an out-of-balance sheet honestly rather than silently accepting it", () => {
  const rows = [
    { category: "Assets", accountCode: "1000", netBalance: 5000 },
    { category: "Liabilities", accountCode: "2000", netBalance: 2000 },
    { category: "Equity", accountCode: "3000", netBalance: 1000 }
  ];
  assert.equal(groupRowsForBalanceSheet(rows).isBalanced, false);
});

test("groupRowsForProfitAndLoss computes Net Income = Revenue - Expense", () => {
  const rows = [
    { category: "Revenue", accountCode: "4000", netBalance: 10000 },
    { category: "Expense", accountCode: "5000", netBalance: 6000 }
  ];
  const result = groupRowsForProfitAndLoss(rows);
  assert.equal(result.totalRevenue, 10000);
  assert.equal(result.totalExpense, 6000);
  assert.equal(result.netIncome, 4000);
});

test("computeRetainedEarnings applies the real opening + Net Income - dividends formula", () => {
  assert.equal(computeRetainedEarnings(1000, 4000, 0), 5000);
  assert.equal(computeRetainedEarnings(1000, -500, 0), 500);
  assert.equal(computeRetainedEarnings(0, 1000, 200), 800);
});

test("summarizeAging groups open receivables/payables into real configured buckets", () => {
  const buckets = [{ label: "Current", minDays: null, maxDays: 0 }, { label: "1-30 Days", minDays: 1, maxDays: 30 }];
  // Not yet due (0 days overdue) -> Current; the other two are 5 and 1 days overdue -> 1-30 Days.
  const records = [{ dueDate: "2027-01-25", outstandingBalance: 100 }, { dueDate: "2027-01-20", outstandingBalance: 200 }, { dueDate: "2027-01-24", outstandingBalance: 50 }];
  const result = summarizeAging(records, buckets, new Date("2027-01-25"));
  assert.equal(result.totalAmount, 350);
  const current = result.buckets.find((b) => b.label === "Current");
  assert.equal(current.count, 1);
  assert.equal(current.amount, 100);
  const bucket130 = result.buckets.find((b) => b.label === "1-30 Days");
  assert.equal(bucket130.count, 2);
  assert.equal(bucket130.amount, 250);
});

test("computeBudgetVariance is positive (under budget) or negative (over budget), with a real percent", () => {
  assert.deepEqual(computeBudgetVariance(1000, 800), { variance: 200, variancePercent: 20, isOverBudget: false });
  assert.deepEqual(computeBudgetVariance(1000, 1200), { variance: -200, variancePercent: -20, isOverBudget: true });
  assert.equal(computeBudgetVariance(0, 100).variancePercent, null);
});

test("summarizeCashFlow uses the transaction's own real direction as the inflow/outflow signal, itemized by type", () => {
  const txns = [
    { type: "Payment", direction: "Credit", amount: 500 },
    { type: "Payment", direction: "Credit", amount: 300 },
    { type: "ExpenseReimbursement", direction: "Debit", amount: 200 }
  ];
  const result = summarizeCashFlow(txns);
  assert.equal(result.totalInflow, 800);
  assert.equal(result.totalOutflow, 200);
  assert.equal(result.netCashFlow, 600);
  const paymentLine = result.lines.find((l) => l.type === "Payment");
  assert.equal(paymentLine.inflow, 800);
});

test("flattenReportRows normalizes every real report data shape (rows/lines/buckets/sections/scalar) into a flat table", () => {
  assert.deepEqual(flattenReportRows("TrialBalance", { rows: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(flattenReportRows("CashFlow", { lines: [{ b: 2 }] }), [{ b: 2 }]);
  assert.deepEqual(flattenReportRows("ARAging", { buckets: [{ c: 3 }] }), [{ c: 3 }]);
  assert.deepEqual(flattenReportRows("BalanceSheet", { sections: { Assets: [{ d: 4 }], Equity: [{ e: 5 }] } }), [{ section: "Assets", d: 4 }, { section: "Equity", e: 5 }]);
  assert.deepEqual(flattenReportRows("RetainedEarnings", { netIncome: 100, dividends: 0 }), [{ netIncome: 100, dividends: 0 }]);
});
