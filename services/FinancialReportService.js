import FinancialReportModel from "../models/FinancialReportModel.js";
import LedgerEntryModel from "../models/LedgerEntryModel.js";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import ExpenseBudgetModel from "../models/ExpenseBudgetModel.js";
import BankTransactionModel from "../models/BankTransactionModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import PaymentModel from "../models/PaymentModel.js";
import ReceiptModel from "../models/ReceiptModel.js";
import ExpenseModel from "../models/ExpenseModel.js";
import LedgerService, { normalizeBalanceForCategory } from "./LedgerService.js";
import JournalService from "./JournalService.js";
import TaxService from "./TaxService.js";
import { isPayableTerminal } from "./AccountsPayableService.js";
import { computeAgingBucket } from "../utils/agingUtils.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;
// Exported so other modules (KPIEngine's Finance dashboard extension) reuse
// this exact same real definition rather than re-hardcoding it.
export const AR_TERMINAL_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/financialReportService.test.js).
// ---------------------------------------------------------------------------

export const isReportArchivable = (status) => status === "Generated";

/** "Balance Sheet: Assets = Liabilities + Equity." Groups already-computed trial-balance rows (LedgerService.getTrialBalance's own output) into the three real sections — never a second balance computation. */
export const groupRowsForBalanceSheet = (trialBalanceRows) => {
  const sections = { Assets: [], Liabilities: [], Equity: [] };
  for (const row of trialBalanceRows) {
    if (sections[row.category]) sections[row.category].push(row);
  }
  const totals = {
    totalAssets: roundCurrency(sections.Assets.reduce((sum, r) => sum + r.netBalance, 0)),
    totalLiabilities: roundCurrency(sections.Liabilities.reduce((sum, r) => sum + r.netBalance, 0)),
    totalEquity: roundCurrency(sections.Equity.reduce((sum, r) => sum + r.netBalance, 0))
  };
  const isBalanced = Math.abs(totals.totalAssets - (totals.totalLiabilities + totals.totalEquity)) < 0.01;
  return { sections, ...totals, isBalanced };
};

/** "Profit & Loss: Revenue - Expense = Net Income." Groups period-movement rows (Revenue/Expense account activity within a date range) into the two real sections. */
export const groupRowsForProfitAndLoss = (periodRows) => {
  const sections = { Revenue: [], Expense: [] };
  for (const row of periodRows) {
    if (sections[row.category]) sections[row.category].push(row);
  }
  const totalRevenue = roundCurrency(sections.Revenue.reduce((sum, r) => sum + r.netBalance, 0));
  const totalExpense = roundCurrency(sections.Expense.reduce((sum, r) => sum + r.netBalance, 0));
  const netIncome = roundCurrency(totalRevenue - totalExpense);
  return { sections, totalRevenue, totalExpense, netIncome };
};

/** "Retained Earnings: opening + Net Income - Dividends." A real, minimal formula — dividends is always 0 (see utils/financeConfig.js's own doc comment for why). */
export const computeRetainedEarnings = (openingRetainedEarnings, netIncome, dividends = 0) =>
  roundCurrency((openingRetainedEarnings || 0) + (netIncome || 0) - (dividends || 0));

/** Groups open receivables/payables into real aging buckets — the summarized REPORT view `computeAgingBucket` (Part 5/6) never had before this Part; the per-record bucket function itself is untouched/reused as-is. */
export const summarizeAging = (records, buckets, referenceDate) => {
  const byBucket = new Map(buckets.map((b) => [b.label, { label: b.label, count: 0, amount: 0 }]));
  let totalAmount = 0;
  for (const record of records) {
    const { label } = computeAgingBucket(record.dueDate, referenceDate, buckets);
    if (!label) continue;
    const entry = byBucket.get(label);
    entry.count += 1;
    entry.amount = roundCurrency(entry.amount + record.outstandingBalance);
    totalAmount = roundCurrency(totalAmount + record.outstandingBalance);
  }
  return { buckets: [...byBucket.values()], totalAmount };
};

/** "Budget vs Actual." Real variance = allocated - actual (positive = under budget, negative = over). */
export const computeBudgetVariance = (allocatedAmount, actualAmount) => {
  const variance = roundCurrency((allocatedAmount || 0) - (actualAmount || 0));
  const variancePercent = allocatedAmount > 0 ? roundCurrency((variance / allocatedAmount) * 100) : null;
  return { variance, variancePercent, isOverBudget: variance < 0 };
};

/** "Cash Flow Statement... Direct Method." Real: a bank transaction's own `direction` (Credit=inflow, Debit=outflow) IS the real signal — never guessed from `type`. */
export const summarizeCashFlow = (transactions) => {
  const byType = new Map();
  let totalInflow = 0;
  let totalOutflow = 0;
  for (const txn of transactions) {
    if (!byType.has(txn.type)) byType.set(txn.type, { type: txn.type, inflow: 0, outflow: 0 });
    const entry = byType.get(txn.type);
    if (txn.direction === "Credit") { entry.inflow = roundCurrency(entry.inflow + txn.amount); totalInflow = roundCurrency(totalInflow + txn.amount); }
    else { entry.outflow = roundCurrency(entry.outflow + txn.amount); totalOutflow = roundCurrency(totalOutflow + txn.amount); }
  }
  return { lines: [...byType.values()], totalInflow, totalOutflow, netCashFlow: roundCurrency(totalInflow - totalOutflow) };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class FinancialReportService {
  /**
   * Public wrapper around `_resolvePeriodRange` — Finance Module Part
   * 26's own `services/FinancialAnalyticsService.js` reuses this exact
   * same real "YYYY" / "YYYY-MM" / "YYYY-Q#" / periodStart+periodEnd
   * parser directly rather than duplicating it a second time.
   */
  static async resolvePeriodRange(period, periodStart, periodEnd) {
    return FinancialReportService._resolvePeriodRange(period, periodStart, periodEnd);
  }

  static async _resolvePeriodRange(period, periodStart, periodEnd) {
    if (periodStart || periodEnd) return { start: periodStart ? new Date(periodStart) : null, end: periodEnd ? new Date(periodEnd) : new Date() };
    if (!period) return { start: null, end: new Date() };

    const quarterMatch = period.match(/^(\d{4})-Q([1-4])$/);
    if (quarterMatch) {
      const year = parseInt(quarterMatch[1], 10);
      const quarter = parseInt(quarterMatch[2], 10);
      const startMonth = (quarter - 1) * 3;
      return { start: new Date(Date.UTC(year, startMonth, 1)), end: new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999)) };
    }
    const monthMatch = period.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
      const year = parseInt(monthMatch[1], 10);
      const month = parseInt(monthMatch[2], 10);
      return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)) };
    }
    const yearMatch = period.match(/^(\d{4})$/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) };
    }
    throw new Error(`Unrecognized period format "${period}" — use "YYYY", "YYYY-MM", or "YYYY-Q#", or supply periodStart/periodEnd directly.`);
  }

  /**
   * Public wrapper around `_getPeriodMovement` — Finance Module Part
   * 25's own `services/KPIEngine.js` extension calls this directly for
   * "Today's Revenue"/"Today's Expenses" rather than duplicating the
   * same real GL aggregation a second time.
   */
  static async getPeriodMovement(tenantId, start, end, currency, categories) {
    return FinancialReportService._getPeriodMovement(tenantId, start, end, currency, categories);
  }

  /**
   * Real GL movement for ONE specific account (by code) within a date
   * range — Financial Analytics Platform Enhancements (Part 29) own
   * `computeEBITDA` add-back lookups (interest/income-tax/depreciation/
   * amortization expense, each an optionally-configured account code)
   * call this rather than duplicating the aggregation `_getPeriodMovement`
   * already does per-category. Returns 0 (not null/undefined) when the
   * code isn't configured or the account has no postings — the real,
   * honest "nothing to add back" answer, not a fabricated figure.
   */
  static async getAccountCodeMovement(tenantId, accountCode, start, end) {
    if (!accountCode) return 0;
    const account = await ChartOfAccountModel.findOne({ tenantId, accountCode }).select("_id category").lean();
    if (!account) return 0;

    const matchStage = { tenantId, accountId: account._id, postingDate: { $lte: end } };
    if (start) matchStage.postingDate.$gte = start;
    const grouped = await LedgerEntryModel.aggregate([
      { $match: matchStage },
      { $group: { _id: null, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } }
    ]);
    if (grouped.length === 0) return 0;

    const { netBalance } = normalizeBalanceForCategory(account.category, grouped[0].debit - grouped[0].credit);
    return roundCurrency(netBalance);
  }

  /** Real period-movement aggregation — mirrors LedgerService.getTrialBalance's own aggregation exactly, but summed WITHIN a date range (not as-of), for Revenue/Expense accounts (Profit & Loss's own real data source). */
  static async _getPeriodMovement(tenantId, start, end, currency, categories) {
    const matchStage = { tenantId, postingDate: { $lte: end } };
    if (start) matchStage.postingDate.$gte = start;

    const grouped = await LedgerEntryModel.aggregate([
      { $match: matchStage },
      { $group: { _id: "$accountId", debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } }
    ]);
    if (grouped.length === 0) return [];

    const accounts = await ChartOfAccountModel.find({ tenantId, _id: { $in: grouped.map((g) => g._id) }, category: { $in: categories } }).lean();
    const accountsById = new Map(accounts.map((a) => [a._id.toString(), a]));

    return grouped
      .map((g) => {
        const account = accountsById.get(g._id.toString());
        if (!account) return null;
        if (currency && account.currency !== currency) return null;
        const { debitBalance, creditBalance, netBalance } = normalizeBalanceForCategory(account.category, g.debit - g.credit);
        return { accountId: account._id.toString(), accountCode: account.accountCode, accountName: account.name, category: account.category, currency: account.currency, debitBalance, creditBalance, netBalance };
      })
      .filter(Boolean)
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }

  /**
   * POST /api/v1/financial-reports/generate
   * Validate Parameters -> Validate Accounting Period -> Retrieve Ledger
   * Entries -> Aggregate Balances -> Generate Report -> Store Report
   * History -> Publish ReportGenerated. Dispatches by `reportType` — every
   * branch reads from an already-real, already-immutable source; none
   * recalculates a business transaction directly (see this module's own
   * "never calculate business transactions directly" opening principle).
   */
  static async generateReport(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { reportType, period = null, periodStart = null, periodEnd = null, currency = null, ...params } = data;
    if (!config.reportTypes.includes(reportType)) throw new Error(`Invalid reportType "${reportType}".`);

    publishEvent("ReportRequested", { tenantId, reportType, period, performedBy: userId || null });

    const { start, end } = await FinancialReportService._resolvePeriodRange(period, periodStart, periodEnd);
    let reportData;

    switch (reportType) {
      case "TrialBalance": {
        reportData = await LedgerService.getTrialBalance({ financialYear: params.financialYear, currency, date: end }, tenantId);
        break;
      }
      case "BalanceSheet": {
        const trialBalance = await LedgerService.getTrialBalance({ currency, date: end }, tenantId);
        reportData = { asOfDate: end, currency, ...groupRowsForBalanceSheet(trialBalance.rows) };
        break;
      }
      case "ProfitAndLoss": {
        const periodRows = await FinancialReportService._getPeriodMovement(tenantId, start, end, currency, ["Revenue", "Expense"]);
        reportData = { periodStart: start, periodEnd: end, currency, ...groupRowsForProfitAndLoss(periodRows) };
        break;
      }
      case "RetainedEarnings": {
        const priorPeriodRows = start ? await FinancialReportService._getPeriodMovement(tenantId, null, new Date(start.getTime() - 1), currency, ["Revenue", "Expense"]) : [];
        const openingRetainedEarnings = groupRowsForProfitAndLoss(priorPeriodRows).netIncome;
        const periodRows = await FinancialReportService._getPeriodMovement(tenantId, start, end, currency, ["Revenue", "Expense"]);
        const { netIncome } = groupRowsForProfitAndLoss(periodRows);
        const dividends = 0; // No dividend/distribution concept exists in this codebase — see utils/financeConfig.js's own doc comment.
        reportData = { periodStart: start, periodEnd: end, currency, openingRetainedEarnings, netIncome, dividends, closingRetainedEarnings: computeRetainedEarnings(openingRetainedEarnings, netIncome, dividends) };
        break;
      }
      case "CashFlow": {
        const txnFilter = { tenantId, createdAt: { $lte: end } };
        if (start) txnFilter.createdAt.$gte = start;
        if (currency) txnFilter.currency = currency;
        if (params.bankAccountId) txnFilter.bankAccountId = params.bankAccountId;
        const transactions = await BankTransactionModel.find(txnFilter).select("type direction amount currency").lean();
        reportData = { periodStart: start, periodEnd: end, currency, method: "Direct", scope: "Operating activities only — see this Part's own Deferred notes for Investing/Financing scope.", ...summarizeCashFlow(transactions) };
        break;
      }
      case "GeneralLedger": {
        reportData = await LedgerService.listEntries({ accountId: params.accountId, dateFrom: start, dateTo: end, currency, sort: params.sort }, tenantId);
        break;
      }
      case "JournalRegister": {
        reportData = await JournalService.listJournals({ status: params.status, journalType: params.journalType, dateFrom: start, dateTo: end, currency, sort: params.sort }, tenantId);
        break;
      }
      case "ARAging": {
        const referenceDate = end;
        const receivables = await AccountsReceivableModel.find({ tenantId, status: { $nin: [...AR_TERMINAL_STATUSES] }, outstandingBalance: { $gt: 0 }, ...(currency ? { currency } : {}) }).select("dueDate outstandingBalance customerName invoiceNumber").lean();
        reportData = { asOfDate: referenceDate, currency, ...summarizeAging(receivables, config.agingBuckets, referenceDate), recordCount: receivables.length };
        break;
      }
      case "APAging": {
        const referenceDate = end;
        const payables = (await AccountsPayableModel.find({ tenantId, outstandingBalance: { $gt: 0 }, ...(currency ? { currency } : {}) }).select("status dueDate outstandingBalance vendorName invoiceNumber").lean()).filter((p) => !isPayableTerminal(p.status));
        reportData = { asOfDate: referenceDate, currency, ...summarizeAging(payables, config.agingBuckets, referenceDate), recordCount: payables.length };
        break;
      }
      case "TaxReport": {
        // Delegates entirely to Part 20's own real TaxService — never a
        // second tax aggregation. Wrapped in this module's own unified
        // history/export envelope for discoverability alongside every
        // other report type.
        reportData = await TaxService.generateTaxReport({ reportType: params.taxReportType || "Custom", periodStart: start, periodEnd: end, country: params.country, currency: currency || params.currency }, tenantId, userId);
        break;
      }
      case "BudgetVsActual": {
        const budgets = await ExpenseBudgetModel.find({ tenantId, ...(params.scope ? { scope: params.scope } : {}), ...(params.period ? { period: params.period } : {}) }).lean();
        const lines = budgets.map((b) => ({
          scope: b.scope, scopeRef: b.scopeRef, period: b.period, currency: b.currency,
          allocatedAmount: b.allocatedAmount, actualAmount: b.consumedAmount, ...computeBudgetVariance(b.allocatedAmount, b.consumedAmount)
        }));
        reportData = { currency, lines, totalAllocated: roundCurrency(lines.reduce((s, l) => s + l.allocatedAmount, 0)), totalActual: roundCurrency(lines.reduce((s, l) => s + l.actualAmount, 0)) };
        break;
      }
      case "Custom": {
        // "Custom Reports" — a real, honestly-scoped ad-hoc ledger query
        // (caller-supplied account/category/date filters run through the
        // same real LedgerEntryModel aggregation every other report type
        // uses), not a free-form report designer.
        const customRows = await FinancialReportService._getPeriodMovement(tenantId, start, end, currency, params.categories || ["Assets", "Liabilities", "Equity", "Revenue", "Expense"]);
        const filteredRows = params.accountCodes?.length > 0 ? customRows.filter((r) => params.accountCodes.includes(r.accountCode)) : customRows;
        reportData = { periodStart: start, periodEnd: end, currency, rows: filteredRows, total: roundCurrency(filteredRows.reduce((s, r) => s + r.netBalance, 0)) };
        publishEvent("CustomReportCreated", { tenantId, reportType, performedBy: userId || null });
        break;
      }
      default:
        throw new Error(`Report type "${reportType}" is not yet supported.`);
    }

    const report = await FinancialReportModel.create({
      tenantId, reportType, period, periodStart: start, periodEnd: end, asOfDate: end, currency,
      parameters: { period, periodStart, periodEnd, currency, ...params }, data: reportData, status: "Generated",
      generatedBy: userId || null, generatedAt: new Date(),
      expiresAt: config.reportRetentionDays > 0 ? new Date(Date.now() + config.reportRetentionDays * 24 * 60 * 60 * 1000) : null,
      timeline: [{ event: "ReportGenerated", description: `${reportType} report generated${period ? ` for ${period}` : ""}.`, performedBy: userId || null }]
    });

    await AuditLogModel.create({ action: "finance.report.generate", module: "Finance", resource: "FinancialReport", resourceId: report._id.toString(), userId: userId || null, tenantId, details: { reportType, period } });
    publishEvent("ReportGenerated", { tenantId, reportId: report._id.toString(), reportType, period, performedBy: userId || null, module: "Finance" });

    return report.toJSON();
  }

  static async listReports(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.reportType) filter.reportType = query.reportType;
    if (query.status) filter.status = query.status;
    if (query.currency) filter.currency = query.currency;
    if (query.period) filter.period = query.period;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { generatedAt: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      FinancialReportModel.find(filter).select("-data").sort(sortSpec).skip(skip).limit(pageSize).lean(),
      FinancialReportModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getReportById(reportId, tenantId) {
    const report = await FinancialReportModel.findOne({ _id: reportId, tenantId }).lean();
    if (!report) throw new Error("Financial report not found.");
    return report;
  }

  static async archiveReport(reportId, tenantId, userId) {
    const report = await FinancialReportModel.findOne({ _id: reportId, tenantId });
    if (!report) throw new Error("Financial report not found.");
    if (!isReportArchivable(report.status)) throw new Error(`Report cannot be archived from status "${report.status}".`);

    report.status = "Archived";
    report.timeline.push({ event: "ReportArchived", description: "Report archived.", performedBy: userId || null });
    await report.save();

    await AuditLogModel.create({ action: "finance.report.archive", module: "Finance", resource: "FinancialReport", resourceId: report._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("ReportArchived", { tenantId, reportId: report._id.toString(), performedBy: userId || null });

    return report.toJSON();
  }

  static async cancelReport(reportId, tenantId, userId) {
    const report = await FinancialReportModel.findOne({ _id: reportId, tenantId });
    if (!report) throw new Error("Financial report not found.");
    if (report.status !== "Generated") throw new Error(`Report cannot be cancelled from status "${report.status}".`);

    report.status = "Cancelled";
    report.timeline.push({ event: "ReportCancelled", description: "Report cancelled.", performedBy: userId || null });
    await report.save();

    return report.toJSON();
  }

  /**
   * GET /api/v1/financial-reports/{reportId}/drill-down?accountId=...
   * "Drill-Down: Account, Journal Entry, Invoice, Payment, Receipt,
   * Expense, Bank Transaction. Full navigation." Account/Journal Entry
   * drill-down is real and FK-backed (`LedgerEntryModel.accountId`/
   * `journalId`); resolving further to the ORIGINATING Invoice/Payment/
   * Receipt/Expense/BankTransaction is real but best-effort — journals
   * only carry a plain `referenceNumber` string (Part 3), not a typed FK
   * to whichever document triggered them, so this matches that string
   * against each candidate collection's own real number field in turn.
   * Honestly documented, not silently assumed guaranteed.
   */
  static async drillDown(reportId, query, tenantId) {
    const report = await FinancialReportModel.findOne({ _id: reportId, tenantId }).lean();
    if (!report) throw new Error("Financial report not found.");
    const { accountId } = query;
    if (!accountId) throw new Error("accountId is required for drill-down.");

    const filter = { tenantId, accountId };
    if (report.periodStart) filter.postingDate = { $gte: report.periodStart, $lte: report.periodEnd || report.asOfDate };
    else if (report.asOfDate) filter.postingDate = { $lte: report.asOfDate };

    const entries = await LedgerEntryModel.find(filter).sort({ postingDate: 1, sequence: 1 }).limit(500).lean();

    const referenceNumbers = [...new Set(entries.map((e) => e.referenceNumber).filter(Boolean))];
    const [invoices, payments, receipts, expenses, bankTxns] = referenceNumbers.length > 0 ? await Promise.all([
      InvoiceModel.find({ tenantId, invoiceNumber: { $in: referenceNumbers } }).select("invoiceNumber").lean(),
      PaymentModel.find({ tenantId, paymentNumber: { $in: referenceNumbers } }).select("paymentNumber").lean(),
      ReceiptModel.find({ tenantId, receiptNumber: { $in: referenceNumbers } }).select("receiptNumber").lean(),
      ExpenseModel.find({ tenantId, expenseNumber: { $in: referenceNumbers } }).select("expenseNumber").lean(),
      BankTransactionModel.find({ tenantId, transactionNumber: { $in: referenceNumbers } }).select("transactionNumber").lean()
    ]) : [[], [], [], [], []];

    const sourceByRef = new Map();
    invoices.forEach((d) => sourceByRef.set(d.invoiceNumber, { sourceType: "Invoice", sourceId: d._id }));
    payments.forEach((d) => sourceByRef.set(d.paymentNumber, { sourceType: "Payment", sourceId: d._id }));
    receipts.forEach((d) => sourceByRef.set(d.receiptNumber, { sourceType: "Receipt", sourceId: d._id }));
    expenses.forEach((d) => sourceByRef.set(d.expenseNumber, { sourceType: "Expense", sourceId: d._id }));
    bankTxns.forEach((d) => sourceByRef.set(d.transactionNumber, { sourceType: "BankTransaction", sourceId: d._id }));

    return entries.map((entry) => ({ ...entry, source: sourceByRef.get(entry.referenceNumber) || null }));
  }
}

export default FinancialReportService;
