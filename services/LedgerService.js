import LedgerEntryModel from "../models/LedgerEntryModel.js";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import ChartOfAccountService from "./ChartOfAccountService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CacheManager from "../utils/cacheManager.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly.
// ---------------------------------------------------------------------------

// Debit-normal categories increase with a debit; credit-normal categories
// (Liabilities, Equity, Revenue) increase with a credit. This is a fixed
// accounting invariant, not a tenant preference, so unlike category/type/
// status it is not config-driven.
export const DEBIT_NORMAL_CATEGORIES = new Set(["Assets", "Expense"]);

/** previousBalance + debit - credit — the raw, signed ledger movement. */
export const computeRunningBalance = (previousBalance, debit, credit) =>
  roundCurrency((previousBalance || 0) + (Number(debit) || 0) - (Number(credit) || 0));

/**
 * "Balance Validation: Every posting validates Debit Total = Credit Total.
 * Out-of-balance posting rejected." This is the General Ledger's own stated
 * rule (independent of JournalService's identical check at journal
 * creation/update time in Part 3) — the Posting Engine re-verifies right
 * before writing irreversible entries, so it never trusts an upstream
 * caller's validation as the only line of defense for something immutable.
 */
export const assertLinesBalance = (lines) => {
  const debitTotal = roundCurrency(lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0));
  const creditTotal = roundCurrency(lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0));
  if (debitTotal !== creditTotal) {
    throw new Error(`Out-of-balance posting rejected: total debit (${debitTotal}) does not equal total credit (${creditTotal}).`);
  }
};

/**
 * Splits a raw signed running balance into Debit/Credit trial-balance
 * columns. This split is deliberately category-independent — it's purely
 * the sign of (debit - credit), exactly like a real trial balance column:
 * an account sitting on its "wrong" side (e.g. a Liability with a net
 * debit) still shows in the Debit column, not silently flipped. This is
 * also what keeps "total Debit column = total Credit column" true across
 * an entire trial balance regardless of account mix.
 *
 * `netBalance` is the one category-aware figure here — positive when the
 * balance sits on the account's normal side (so "Current Balance" reads as
 * a plain positive number for both a debit-normal Asset and a credit-normal
 * Liability), negative when abnormal/contra. It is not used for the
 * debit/credit column split above.
 */
export const normalizeBalanceForCategory = (category, rawBalance) => {
  const rounded = roundCurrency(rawBalance);
  return {
    debitBalance: rounded > 0 ? rounded : 0,
    creditBalance: rounded < 0 ? -rounded : 0,
    netBalance: DEBIT_NORMAL_CATEGORIES.has(category) ? rounded : -rounded
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class LedgerService {
  /**
   * Posting Engine — invoked by JournalService.postJournal once a journal
   * clears approval. Creates one append-only ledger entry per journal line,
   * with a per-(tenant, account) atomically-assigned posting sequence and
   * running balance. Never touches an existing ledger entry.
   */
  static async postJournalEntries(journal, tenantId, userId) {
    assertLinesBalance(journal.lines);

    const createdEntries = [];

    // Sequential on purpose: a journal can post to the same account twice,
    // and correctness of the running balance depends on each line for an
    // account seeing the previous line's freshly-written balance.
    for (const line of journal.lines) {
      const previous = await LedgerEntryModel.findOne({ tenantId, accountId: line.accountId })
        .sort({ sequence: -1 })
        .lean();
      const previousBalance = previous ? previous.runningBalance : 0;
      const sequence = await FinanceSequenceModel.getNext(tenantId, "ledgerAccountSequence", line.accountId.toString());
      const runningBalance = computeRunningBalance(previousBalance, line.debit, line.credit);

      const entry = await LedgerEntryModel.create({
        tenantId,
        journalId: journal._id,
        journalNumber: journal.journalNumber,
        accountId: line.accountId,
        accountCode: line.accountCode,
        postingDate: journal.postingDate,
        debit: line.debit,
        credit: line.credit,
        sequence,
        openingBalance: previousBalance,
        runningBalance,
        currency: journal.currency,
        referenceNumber: journal.referenceNumber,
        description: line.description || journal.description,
        postedBy: userId || null
      });

      createdEntries.push(entry);
      await ChartOfAccountService.markAsPosted(line.accountId, tenantId);
    }

    await CacheManager.invalidatePattern(`finance:balance:${tenantId}:*`);
    await CacheManager.invalidatePattern(`finance:trial-balance:${tenantId}:*`);

    for (const entry of createdEntries) {
      publishEvent("LedgerEntryCreated", {
        tenantId,
        ledgerEntryId: entry._id.toString(),
        journalId: journal._id.toString(),
        accountId: entry.accountId.toString(),
        performedBy: userId || null
      });
    }
    publishEvent("LedgerBalanceUpdated", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

    return createdEntries.map((entry) => entry.toJSON());
  }

  /**
   * GET /api/v1/general-ledger
   */
  static async listEntries(query, tenantId) {
    const config = getFinanceConfig();
    const { accountId, dateFrom, dateTo, currency, journalNumber, referenceNumber, sort } = query;

    const filter = { tenantId };
    if (accountId) filter.accountId = accountId;
    if (currency) filter.currency = currency;
    if (journalNumber) filter.journalNumber = journalNumber;
    if (referenceNumber) filter.referenceNumber = referenceNumber;
    if (dateFrom || dateTo) {
      filter.postingDate = {};
      if (dateFrom) filter.postingDate.$gte = new Date(dateFrom);
      if (dateTo) filter.postingDate.$lte = new Date(dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultLedgerPageSize, 1), config.maxLedgerPageSize);
    const skip = (page - 1) * pageSize;

    // Chronological by default — ledger entries are append-only history.
    let sortSpec = { postingDate: 1, sequence: 1 };
    if (sort) {
      const direction = sort.startsWith("-") ? -1 : 1;
      const field = sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      LedgerEntryModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      LedgerEntryModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/general-ledger/{accountId}/balance
   * Always computed from the immutable ledger (aggregation), never from a
   * potentially-stale cached field — cached only at the response layer
   * (CacheManager, short TTL, invalidated on every posting/recalculate).
   */
  static async getAccountBalance(accountId, tenantId, options = {}) {
    const config = getFinanceConfig();
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId }).lean();
    if (!account) throw new Error("Account not found.");

    const asOfDate = options.asOfDate ? new Date(options.asOfDate) : new Date();
    const cacheKey = `finance:balance:${tenantId}:${accountId}:${asOfDate.toISOString().slice(0, 10)}`;

    const { data } = await CacheManager.getOrCompute(cacheKey, async () => {
      const period = await FinancialPeriodService.findPeriodForDate(tenantId, asOfDate);

      const sumEntries = async (filter) => {
        const [result] = await LedgerEntryModel.aggregate([
          { $match: filter },
          { $group: { _id: null, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } }
        ]);
        return { debit: result?.debit || 0, credit: result?.credit || 0 };
      };

      const baseFilter = { tenantId, accountId: account._id };
      const [openingTotals, closingTotals] = await Promise.all([
        period ? sumEntries({ ...baseFilter, postingDate: { $lt: period.startDate } }) : Promise.resolve({ debit: 0, credit: 0 }),
        sumEntries({ ...baseFilter, postingDate: { $lte: asOfDate } })
      ]);

      const opening = normalizeBalanceForCategory(account.category, openingTotals.debit - openingTotals.credit);
      const closing = normalizeBalanceForCategory(account.category, closingTotals.debit - closingTotals.credit);

      return {
        accountId: account._id.toString(),
        accountCode: account.accountCode,
        accountName: account.name,
        category: account.category,
        currency: account.currency,
        financialPeriod: period
          ? { financialYear: period.financialYear, periodType: period.periodType, startDate: period.startDate, endDate: period.endDate, status: period.status }
          : null,
        asOfDate,
        openingBalance: opening.netBalance,
        debitTotal: roundCurrency(closingTotals.debit),
        creditTotal: roundCurrency(closingTotals.credit),
        closingBalance: closing.netBalance,
        currentBalance: closing.netBalance
      };
    }, config.accountBalanceCacheTtlSeconds);

    return data;
  }

  /**
   * GET /api/v1/general-ledger/trial-balance
   * Only accounts with actual ledger activity in range appear — matching
   * how a real trial balance behaves (zero-activity accounts are omitted).
   */
  static async getTrialBalance(query, tenantId) {
    const config = getFinanceConfig();
    const { financialYear, currency } = query;
    const asOfDate = query.date ? new Date(query.date) : new Date();
    const cacheKey = `finance:trial-balance:${tenantId}:${financialYear || "all"}:${currency || "all"}:${asOfDate.toISOString().slice(0, 10)}`;

    const { data } = await CacheManager.getOrCompute(cacheKey, async () => {
      const matchStage = { tenantId, postingDate: { $lte: asOfDate } };
      if (financialYear) {
        const yearStart = new Date(`${financialYear}-01-01T00:00:00.000Z`);
        const yearEnd = new Date(`${financialYear}-12-31T23:59:59.999Z`);
        matchStage.postingDate = { $gte: yearStart, $lte: yearEnd < asOfDate ? yearEnd : asOfDate };
      }

      const grouped = await LedgerEntryModel.aggregate([
        { $match: matchStage },
        { $group: { _id: "$accountId", debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } }
      ]);

      if (grouped.length === 0) {
        publishEvent("TrialBalanceGenerated", { tenantId, financialYear: financialYear || null, currency: currency || null, asOfDate, isBalanced: true });
        return { asOfDate, financialYear: financialYear || null, currency: currency || null, rows: [], totalDebitBalance: 0, totalCreditBalance: 0, isBalanced: true };
      }

      const accounts = await ChartOfAccountModel.find({ tenantId, _id: { $in: grouped.map((g) => g._id) } }).lean();
      const accountsById = new Map(accounts.map((a) => [a._id.toString(), a]));

      const rows = grouped
        .map((g) => {
          const account = accountsById.get(g._id.toString());
          if (!account) return null;
          if (currency && account.currency !== currency) return null;
          const { debitBalance, creditBalance, netBalance } = normalizeBalanceForCategory(account.category, g.debit - g.credit);
          return {
            accountId: account._id.toString(),
            accountCode: account.accountCode,
            accountName: account.name,
            category: account.category,
            currency: account.currency,
            debitBalance,
            creditBalance,
            netBalance
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

      const totalDebitBalance = roundCurrency(rows.reduce((sum, r) => sum + r.debitBalance, 0));
      const totalCreditBalance = roundCurrency(rows.reduce((sum, r) => sum + r.creditBalance, 0));
      // "Total Debits = Total Credits. Validation mandatory." — a real
      // computed integrity check on every response, not an assumption.
      const isBalanced = Math.abs(totalDebitBalance - totalCreditBalance) < 0.01;

      // Fired only on an actual (non-cached) computation — "Generated"
      // describes a fresh computation happening, not every read.
      publishEvent("TrialBalanceGenerated", { tenantId, financialYear: financialYear || null, currency: currency || null, asOfDate, isBalanced });

      return { asOfDate, financialYear: financialYear || null, currency: currency || null, rows, totalDebitBalance, totalCreditBalance, isBalanced };
    }, config.trialBalanceCacheTtlSeconds);

    return data;
  }

  /**
   * POST /api/v1/general-ledger/recalculate — Administrator only (enforced
   * by the controller's permission check, not here).
   *
   * "No ledger modification" — LedgerEntryModel is schema-immutable (see
   * models/LedgerEntryModel.js), so recalculation cannot and does not touch
   * stored entries. Every balance/trial-balance read already aggregates
   * directly from the immutable ledger rather than trusting a cached
   * runningBalance; recalculate's real job is invalidating those cached
   * reads so the next request recomputes from source.
   */
  static async recalculate(tenantId, userId) {
    await CacheManager.invalidatePattern(`finance:balance:${tenantId}:*`);
    await CacheManager.invalidatePattern(`finance:trial-balance:${tenantId}:*`);

    await AuditLogModel.create({
      action: "finance.ledger.recalculate",
      module: "Finance",
      resource: "GeneralLedger",
      resourceId: tenantId,
      userId: userId || null,
      tenantId,
      details: {}
    });

    publishEvent("LedgerRecalculated", { tenantId, performedBy: userId || null });

    return {
      tenantId,
      recalculatedAt: new Date(),
      message: "Cached account balances and trial balance summaries invalidated; subsequent reads recompute directly from the immutable ledger."
    };
  }
}

export default LedgerService;
