import mongoose from "mongoose";
import crypto from "crypto";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import JournalModel from "../models/JournalModel.js";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import TaxRuleModel from "../models/TaxRuleModel.js";
import JournalTemplateModel from "../models/JournalTemplateModel.js";
import RecurringJournalModel from "../models/RecurringJournalModel.js";
import JournalBatchModel from "../models/JournalBatchModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import LedgerService from "./LedgerService.js";
// Method-body-only usage below (never at module-evaluation time) — safe
// under the same circular-import pattern CurrencyService.js already uses
// in reverse (it imports JournalService.js and calls it only inside its
// own method bodies, e.g. _postAutomaticJournal).
import CurrencyService from "./CurrencyService.js";
// Real Approval Workflow Platform (Part 22) — no circular import (neither
// module imports the other at module-evaluation time; same reasoning as
// the CurrencyService note above).
import ApprovalWorkflowService from "./ApprovalWorkflowService.js";
import SearchEngineService from "./SearchEngineService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import logger from "../utils/logger.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/journalService.test.js).
// ---------------------------------------------------------------------------

/**
 * "Debit Total = Credit Total" + per-line "exactly one side populated."
 * Throws a descriptive Error on any violation; returns the totals otherwise.
 */
export const validateDoubleEntryLines = (lines) => {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error("A journal requires at least two lines.");
  }

  let debitTotal = 0;
  let creditTotal = 0;

  lines.forEach((line, index) => {
    const debit = roundCurrency(line.debit || 0);
    const credit = roundCurrency(line.credit || 0);
    if (debit < 0 || credit < 0) throw new Error(`Line ${index + 1}: debit/credit cannot be negative.`);
    if (debit > 0 && credit > 0) throw new Error(`Line ${index + 1}: a line cannot have both a debit and a credit.`);
    if (debit === 0 && credit === 0) throw new Error(`Line ${index + 1}: must have either a debit or a credit amount.`);
    debitTotal = roundCurrency(debitTotal + debit);
    creditTotal = roundCurrency(creditTotal + credit);
  });

  if (debitTotal !== creditTotal) {
    throw new Error(`Journal is out of balance: total debit (${debitTotal}) does not equal total credit (${creditTotal}).`);
  }
  if (debitTotal === 0) {
    throw new Error("Journal debit/credit totals cannot both be zero.");
  }

  return { debitTotal, creditTotal };
};

/** Statuses PATCH may operate on. */
export const assertJournalEditable = (journal) => {
  if (journal.status !== "Draft") {
    throw new Error("Only Draft journals can be edited; posted journals are locked.");
  }
};

/** Whether `status` currently qualifies for posting, given the approval-required config toggle. */
export const isPostableStatus = (status, journalApprovalRequired) =>
  journalApprovalRequired ? status === "Approved" : status === "Draft" || status === "Approved";

/**
 * "Posting Restrictions" (Part 36) — real, checkable subset of the spec's
 * own restriction types. "Manual Posting Allowed"/"Manual Posting
 * Blocked"/"System Generated Only" collapse into one real distinction
 * (SystemGeneratedOnly); Merchant/Company/Branch/Subscription-Feature
 * Restricted have no backing entity in this codebase and are dropped —
 * see docs/05-api/07-finance-api.md Part 36. Throws a descriptive Error on
 * violation; returns nothing on success.
 */
export const validatePostingRestriction = (account, { journalType, currency, dimensions = {} }) => {
  const restriction = account.postingRestriction;
  if (!restriction || restriction.type === "Unrestricted") return;

  if (restriction.type === "SystemGeneratedOnly" && journalType !== "Automatic") {
    throw new Error(`Account ${account.accountCode} only accepts system-generated (Automatic) journal postings.`);
  }
  if (restriction.type === "CurrencyRestricted") {
    const allowed = restriction.restrictedCurrencies || [];
    if (allowed.length > 0 && !allowed.includes(currency)) {
      throw new Error(`Account ${account.accountCode} does not accept postings in ${currency} (restricted to ${allowed.join(", ")}).`);
    }
  }
  if (restriction.type === "DimensionRestricted") {
    const restrictedValues = restriction.restrictedDimensionValues || {};
    for (const [dimensionKey, allowedValues] of Object.entries(restrictedValues)) {
      if (!Array.isArray(allowedValues) || allowedValues.length === 0) continue;
      const suppliedValue = dimensions[dimensionKey];
      if (!suppliedValue || !allowedValues.includes(String(suppliedValue))) {
        throw new Error(`Account ${account.accountCode} restricts dimension "${dimensionKey}" to [${allowedValues.join(", ")}]; got "${suppliedValue || "none"}".`);
      }
    }
  }
};

/**
 * "Financial Dimensions... every journal line may contain dimensions."
 * Throws when the target account requires a dimension key the line didn't
 * supply. An account with no `dimensions.required` configured never blocks
 * anything (dimensions remain fully optional by default).
 */
export const validateRequiredDimensions = (account, dimensions = {}) => {
  const required = account.dimensions?.required || [];
  for (const key of required) {
    const dimKey = key.charAt(0).toLowerCase() + key.slice(1);
    if (dimensions[dimKey] === undefined && dimensions[key] === undefined) {
      throw new Error(`Account ${account.accountCode} requires the "${key}" dimension on every posting line.`);
    }
  }
};

/**
 * "Revenue Recognition Journal" (File 2, Journal Platform Part 1) — the
 * real subset of the spec's own "Revenue Rule Exists"/"Deferred Revenue
 * Rule Exists" validations: a journalType of "Revenue Recognition" must
 * post to at least one account carrying a real, configured Part 37
 * `revenueRecognition.deferredRevenueType` (the deferred revenue liability
 * being drawn down) AND at least one Revenue-category account (the revenue
 * being recognized) — i.e. a real Dr Deferred Revenue / Cr Revenue entry,
 * never an unrelated pair of accounts mislabeled as a recognition. No
 * automatic scheduler exists — this only gates a real, manually-triggered
 * posting; every other journalType is unaffected (returns immediately).
 */
export const assertRevenueRecognitionJournal = (journalType, resolvedAccounts) => {
  if (journalType !== "Revenue Recognition") return;
  const hasDeferredRevenueLine = resolvedAccounts.some((account) => account.revenueRecognition?.deferredRevenueType);
  if (!hasDeferredRevenueLine) {
    throw new Error('A "Revenue Recognition" journal requires at least one line posted to an account with a configured revenueRecognition.deferredRevenueType.');
  }
  const hasRevenueLine = resolvedAccounts.some((account) => account.category === "Revenue");
  if (!hasRevenueLine) {
    throw new Error('A "Revenue Recognition" journal requires at least one line posted to a Revenue-category account.');
  }
};

/**
 * "API Response Enhancement" (File 2 Part 3, item 38) — a real, pure
 * derivation over Journal's own single `status` field, the same
 * `deriveApprovalStatus(status)` convention Part 35 already established
 * for Expense. Journal conflates approval and posting into one lifecycle
 * (unlike Expense's longer chain), so Approved/Posted/Archived all
 * honestly collapse to "Approved" — none of them is reachable without
 * having passed approval.
 */
export const deriveApprovalStatus = (status) => {
  if (status === "Draft") return "NotSubmitted";
  if (status === "Pending Approval") return "PendingApproval";
  if (status === "Rejected") return "Rejected";
  if (status === "Cancelled") return "Cancelled";
  return "Approved";
};

/** "Correction Journals" (File 2 Part 2, item 21) — the same one-shot rule reversal already enforces via isReversed. */
export const assertCanCorrect = (journal) => {
  if (journal.status !== "Posted") throw new Error("Only Posted journals can be corrected.");
  if (journal.isCorrected) throw new Error("This journal has already been corrected.");
};

/**
 * "Duplicate Detection" (File 2 Part 2, item 13) — a real, deterministic
 * signature (sorted accountCode:debit:credit tuples + posting date +
 * currency) two independently-created journals would only ever share by
 * genuinely describing the same transaction. Advisory only (see
 * createJournal's own use of this) — never blocks creation, the same
 * "flag, don't block" discipline as ExpenseService.computeFraudRiskScore.
 */
export const computeJournalDuplicateSignature = (lines, postingDate, currency) => {
  const datePart = new Date(postingDate).toISOString().slice(0, 10);
  const linePart = [...lines]
    .map((line) => `${line.accountCode}:${roundCurrency(line.debit || 0)}:${roundCurrency(line.credit || 0)}`)
    .sort()
    .join("|");
  return `${datePart}|${(currency || "").toUpperCase()}|${linePart}`;
};

/**
 * "Recurring Journals" (File 2 Part 2, item 19) — pure date-arithmetic,
 * unit-testable without a live scheduler. Throws on an unconfigured
 * frequency or a missing/invalid customIntervalDays for "Custom".
 */
export const computeNextRunDate = (fromDate, frequency, customIntervalDays = null) => {
  const next = new Date(fromDate);
  switch (frequency) {
    case "Daily": next.setUTCDate(next.getUTCDate() + 1); break;
    case "Weekly": next.setUTCDate(next.getUTCDate() + 7); break;
    case "Monthly": next.setUTCMonth(next.getUTCMonth() + 1); break;
    case "Quarterly": next.setUTCMonth(next.getUTCMonth() + 3); break;
    case "HalfYearly": next.setUTCMonth(next.getUTCMonth() + 6); break;
    case "Yearly": next.setUTCFullYear(next.getUTCFullYear() + 1); break;
    case "Custom": {
      const days = Number(customIntervalDays);
      if (!days || days <= 0) throw new Error('customIntervalDays must be a positive number when frequency is "Custom".');
      next.setUTCDate(next.getUTCDate() + days);
      break;
    }
    default:
      throw new Error(`Invalid recurring journal frequency "${frequency}".`);
  }
  return next;
};

/**
 * "Multi-Currency Storage" (Part 41, item 44) — pure conversion, mirroring
 * the header-level baseCurrencyDebitTotal/baseCurrencyCreditTotal
 * computation (Part 40) at the per-line level. Returns nulls (never a
 * fabricated 1:1 duplicate) when exchangeRate is 1 — the journal's own
 * currency already IS the tenant's base currency, so no conversion ever
 * happened.
 */
export const computeLineBaseCurrencyAmounts = (debit, credit, exchangeRate) => {
  if (!exchangeRate || exchangeRate === 1) return { baseCurrencyDebit: null, baseCurrencyCredit: null };
  return {
    baseCurrencyDebit: roundCurrency((debit || 0) * exchangeRate),
    baseCurrencyCredit: roundCurrency((credit || 0) * exchangeRate)
  };
};

// "cannot be X from status" phrasing matches the same wording
// approveJournal/rejectJournal/cancelJournal already use — deliberately,
// so JournalController's existing statusFromError (which maps "cannot" to
// HTTP 400) classifies these the same real way without needing a new
// special case.

/** "Archiving Strategy" (Part 41, item 50) — Posted only, the same real, bounded guard ChartOfAccountModel's own archiveAccount uses (Part 36). */
export const assertCanArchive = (journal) => {
  if (journal.status !== "Posted") throw new Error(`Journal cannot be archived from status "${journal.status}". Only Posted journals can be archived.`);
};

/** The mirror-opposite restore guard — Archived only. */
export const assertCanRestore = (journal) => {
  if (journal.status !== "Archived") throw new Error(`Journal cannot be restored from status "${journal.status}". Only Archived journals can be restored.`);
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class JournalService {
  static async _generateJournalNumber(tenantId, financialYear) {
    const config = getFinanceConfig();
    const seq = await FinanceSequenceModel.getNext(tenantId, "journalNumber", financialYear);
    return `${config.journalNumberPrefix}-${financialYear}-${String(seq).padStart(6, "0")}`;
  }

  static async _generateBatchNumber(tenantId) {
    const config = getFinanceConfig();
    const seq = await FinanceSequenceModel.getNext(tenantId, "journalBatchNumber", "global");
    return `${config.journalBatchNumberPrefix}-${String(seq).padStart(6, "0")}`;
  }

  static _generateTemplateId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `JTPL-${timestamp}-${random}`;
  }

  /**
   * "Posting Validation Engine" (File 2 Part 2, item 13) — re-validates
   * every line's account status/posting-restriction immediately before it
   * is actually posted, not just at journal-creation time. A journal can
   * sit as Draft/Pending Approval/Approved for days before it's finally
   * posted; an account could be suspended/deactivated in the meantime.
   * Shared by postJournal, reverseJournal, and correctJournal so every
   * real posting path gets the same re-check.
   */
  static async _assertLinesPostable(lines, tenantId, { journalType, currency }) {
    for (const line of lines) {
      const account = await ChartOfAccountModel.findOne({ _id: line.accountId, tenantId });
      if (!account) throw new Error(`Account not found for posting: ${line.accountCode}`);
      if (account.status !== "Active") throw new Error(`Account ${account.accountCode} is not Active.`);
      if (!account.allowPosting) throw new Error(`Account ${account.accountCode} does not allow direct posting.`);
      try {
        validatePostingRestriction(account, { journalType, currency, dimensions: line.dimensions || {} });
      } catch (validationError) {
        publishEvent("AccountValidationFailed", { tenantId, accountId: account._id.toString(), accountCode: account.accountCode, reason: validationError.message });
        throw validationError;
      }
    }
  }

  /**
   * Resolves each raw line's account reference to a real, postable account.
   * Accepts `accountId` (ObjectId, preferred) or `accountCode`/`account`
   * (string) — the latter resolved by exact accountCode match first, then a
   * case-insensitive exact name match as a last resort, for compatibility
   * with the spec's own request example (`"account": "Office Rent Expense"`).
   * "Validate Accounts": must exist in-tenant, be Active, and allow posting.
   */
  static async _resolveAccountsForLines(rawLines, tenantId, { journalType = "Manual", currency = null } = {}) {
    if (!Array.isArray(rawLines) || rawLines.length < 2) {
      throw new Error("A journal requires at least two lines.");
    }

    const resolved = [];
    const accounts = [];
    let lineNumber = 0;
    for (const raw of rawLines) {
      lineNumber += 1;
      const identifier = raw.accountId || raw.accountCode || raw.account;
      if (!identifier) throw new Error("Each journal line requires an account reference (accountId or accountCode).");

      let account = null;
      if (mongoose.isValidObjectId(identifier)) {
        account = await ChartOfAccountModel.findOne({ _id: identifier, tenantId });
      }
      if (!account) {
        account = await ChartOfAccountModel.findOne({ tenantId, accountCode: identifier });
      }
      if (!account) {
        account = await ChartOfAccountModel.findOne({ tenantId, name: new RegExp(`^${escapeRegex(String(identifier).trim())}$`, "i") });
      }
      if (!account) throw new Error(`Account not found: ${identifier}`);
      if (account.status !== "Active") throw new Error(`Account ${account.accountCode} is not Active.`);
      if (!account.allowPosting) throw new Error(`Account ${account.accountCode} does not allow direct posting.`);

      const dimensions = raw.dimensions || {};
      try {
        validatePostingRestriction(account, { journalType, currency, dimensions });
        validateRequiredDimensions(account, dimensions);
      } catch (validationError) {
        publishEvent("AccountValidationFailed", { tenantId, accountId: account._id.toString(), accountCode: account.accountCode, reason: validationError.message });
        throw validationError;
      }

      // "Journal Line Dimensions"/"Tax Code" (Part 41, items 41/43) — a
      // real, optional per-line tax code, validated against a real,
      // existing TaxRuleModel row for the tenant when supplied — the
      // identical real validation ChartOfAccountModel.taxMapping.taxCode
      // already uses (Part 36); never a fabricated code accepted unchecked.
      let taxCode = null;
      if (raw.taxCode) {
        const taxRule = await TaxRuleModel.findOne({ tenantId, taxCode: raw.taxCode.toUpperCase() }).lean();
        if (!taxRule) throw new Error(`taxCode "${raw.taxCode}" does not match any configured tax rule for this tenant.`);
        taxCode = taxRule.taxCode;
      }

      resolved.push({
        lineNumber,
        accountId: account._id,
        accountCode: account.accountCode,
        debit: roundCurrency(raw.debit || 0),
        credit: roundCurrency(raw.credit || 0),
        taxCode,
        description: raw.description || null,
        dimensions
      });
      accounts.push(account);
    }

    return { lines: resolved, accounts };
  }

  /**
   * GET /api/v1/journals
   */
  static async listJournals(query, tenantId) {
    const config = getFinanceConfig();
    const { status, journalType, dateFrom, dateTo, currency, createdBy, sort } = query;

    const filter = { tenantId };
    if (status) filter.status = status;
    if (journalType) filter.journalType = journalType;
    if (currency) filter.currency = currency;
    if (createdBy) filter.createdBy = createdBy;
    if (dateFrom || dateTo) {
      filter.postingDate = {};
      if (dateFrom) filter.postingDate.$gte = new Date(dateFrom);
      if (dateTo) filter.postingDate.$lte = new Date(dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { postingDate: -1, createdAt: -1 };
    if (sort) {
      const direction = sort.startsWith("-") ? -1 : 1;
      const field = sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      JournalModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      JournalModel.countDocuments(filter)
    ]);

    return { items: items.map(JournalService._withCheapJournalFields), pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * "API Response Enhancement" (Part 40, item 38) — cheap, sync-only
   * derived fields (no extra DB round-trip), applied to both listJournals
   * items and getJournalById, the same "cheap fields everywhere, expensive
   * fields single-resource-only" split Part 35 already established for
   * Expense (`withDerivedStatuses` vs. `auditSummary`/`approvalRequest`).
   */
  static _withCheapJournalFields(journal) {
    return {
      ...journal,
      approvalStatus: deriveApprovalStatus(journal.status),
      auditUrl: `/api/v1/audit-events?entityType=Journal&entityId=${journal._id}`
    };
  }

  /**
   * Single-resource-only enrichment — real per-item DB lookups (Accounting
   * Period, the linked real ApprovalRequestModel when one exists) that
   * would be too expensive to run for every row of a list response.
   */
  static async _enrichJournalDetail(journal, tenantId) {
    // Prefers the real, stored financialPeriodId (Part 41) — falls back to
    // the live date-derived lookup only for journals created before this
    // field existed, so old data still enriches correctly.
    const [period, approvalRequest] = await Promise.all([
      journal.financialPeriodId
        ? FinancialPeriodService.findPeriodById(tenantId, journal.financialPeriodId)
        : FinancialPeriodService.findPeriodForDate(tenantId, journal.postingDate),
      journal.approvalRequestId ? ApprovalWorkflowService.getApprovalRequestById(journal.approvalRequestId, tenantId).catch(() => null) : Promise.resolve(null)
    ]);
    return {
      ...JournalService._withCheapJournalFields(journal),
      accountingPeriod: period ? { id: period._id, periodType: period.periodType, financialYear: period.financialYear, status: period.status } : null,
      approvalRequest
    };
  }

  static async getJournalById(journalId, tenantId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId }).lean();
    if (!journal) throw new Error("Journal not found.");
    return JournalService._enrichJournalDetail(journal, tenantId);
  }

  /**
   * POST /api/v1/journals
   * Validate Financial Period -> Validate Accounts -> Validate Debit/Credit
   * Balance -> Create Journal -> Generate Audit -> Publish JournalCreated.
   */
  static async createJournal(data, tenantId, userId) {
    const config = getFinanceConfig();
    const {
      journalType = config.defaultJournalType, postingDate, description = null, referenceNumber = null, currency, lines: rawLines, remarks = null, attachments = [],
      sourceModule = null, sourceEntity = null, sourceId = null, sourceVersion = null, correlationId = null
    } = data;

    if (!postingDate) throw new Error("postingDate is required.");
    const postingDateObj = new Date(postingDate);

    if (sourceModule && !config.journalSourceModules.includes(sourceModule)) {
      throw new Error(`Invalid sourceModule "${sourceModule}".`);
    }

    // "Accounting Period Reference" (Part 41, item 45) — the real period
    // FinancialPeriodService.assertPeriodOpen already resolves, now
    // captured onto the journal itself instead of being discarded (a
    // stored, immutable reference to the period actually in force at
    // posting time — more historically accurate than re-deriving "the
    // period covering this date" live on every future read).
    const financialPeriod = await FinancialPeriodService.assertPeriodOpen(tenantId, postingDateObj);

    const resolvedCurrency = currency || config.defaultCurrency;
    // "Exchange Rate Available" (File 2, Journal Platform Part 1) — a real
    // check via the already-real Conversion Engine (Part 19), not a
    // fabricated new rate lookup. Same-currency-as-base journals need no
    // rate at all and are never blocked by this. The resolved rate — and
    // now also its type/date/source row (Part 41, item 44) — is captured
    // onto the journal itself (Part 40, item 38 first added the bare rate).
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    let exchangeRate = 1;
    let exchangeRateType = null;
    let exchangeRateDate = null;
    let exchangeRateId = null;
    let exchangeRateProvider = null;
    let exchangeRateVersion = null;
    if (resolvedCurrency.toUpperCase() !== baseCurrency.toUpperCase()) {
      const rateResult = await CurrencyService.getRate(tenantId, resolvedCurrency, baseCurrency);
      exchangeRate = rateResult.rate;
      exchangeRateType = rateResult.rateType;
      exchangeRateDate = rateResult.rateDate;
      exchangeRateId = rateResult.rateId;
      exchangeRateProvider = rateResult.rateProvider;
      exchangeRateVersion = rateResult.rateVersion;
    }

    const { lines: resolvedLines, accounts } = await JournalService._resolveAccountsForLines(rawLines, tenantId, { journalType, currency: resolvedCurrency });
    // "Multi-Currency Storage" (Part 41, item 44) — real per-line base
    // currency amounts, computed once here from the same exchangeRate
    // already resolved above (never recalculated later).
    const lines = resolvedLines.map((line) => ({ ...line, ...computeLineBaseCurrencyAmounts(line.debit, line.credit, exchangeRate) }));
    const { debitTotal, creditTotal } = validateDoubleEntryLines(lines);
    assertRevenueRecognitionJournal(journalType, accounts);

    const financialYear = `${postingDateObj.getUTCFullYear()}`;
    const journalNumber = await JournalService._generateJournalNumber(tenantId, financialYear);

    // "Duplicate Detection" + "Duplicate Reference Check" (File 2, Journal
    // Platform Part 2 item 13 / Part 3 item 39) — both advisory only: a
    // match is flagged on the new journal and published for human review,
    // never blocked (see computeJournalDuplicateSignature's own doc
    // comment for why). A referenceNumber that exactly matches another
    // live journal's is flagged the same way, folded into the same real
    // mechanism rather than a second parallel duplicate system.
    const duplicateSignature = computeJournalDuplicateSignature(lines, postingDateObj, resolvedCurrency);
    let possibleDuplicateOfJournalId = null;
    if (config.journalDuplicateDetectionWindowHours > 0) {
      const windowMs = config.journalDuplicateDetectionWindowHours * 60 * 60 * 1000;
      const existing = await JournalModel.findOne({
        tenantId,
        $or: [
          { duplicateSignature, postingDate: { $gte: new Date(postingDateObj.getTime() - windowMs), $lte: new Date(postingDateObj.getTime() + windowMs) } },
          ...(referenceNumber ? [{ referenceNumber }] : [])
        ],
        status: { $nin: ["Rejected", "Cancelled"] }
      }).lean();
      if (existing) possibleDuplicateOfJournalId = existing._id;
    }

    // "Approval Workflow Integration" (Part 40, item 37) — "Journal
    // Platform should not implement approvals internally." Resolved BEFORE
    // create (below) so the real definition-match decision doesn't depend
    // on the journal's own not-yet-assigned _id; startApproval itself
    // (which needs a real entityId) runs immediately AFTER create, once
    // one exists — see the follow-up block below.
    const resolvedApprovalLevels = await ApprovalWorkflowService.resolveApprovalLevels("Journal", { amount: debitTotal, journalType }, tenantId).catch(() => null);

    const journal = await JournalModel.create({
      tenantId,
      journalNumber,
      journalType,
      status: config.defaultJournalStatus,
      postingDate: postingDateObj,
      financialYear,
      description,
      referenceNumber,
      currency: resolvedCurrency,
      lines,
      debitTotal,
      creditTotal,
      remarks,
      attachments,
      sourceModule,
      sourceEntity,
      sourceId,
      sourceVersion,
      correlationId,
      duplicateSignature,
      possibleDuplicateOfJournalId,
      exchangeRate,
      baseCurrency,
      baseCurrencyDebitTotal: roundCurrency(debitTotal * exchangeRate),
      baseCurrencyCreditTotal: roundCurrency(creditTotal * exchangeRate),
      exchangeRateType,
      exchangeRateDate,
      exchangeRateId,
      exchangeRateProvider,
      exchangeRateVersion,
      financialPeriodId: financialPeriod ? financialPeriod._id : null,
      version: 1,
      createdBy: userId || null,
      updatedBy: userId || null
    });

    // Real ApprovalRequestModel started now that a real entityId (the
    // journal's own _id) exists. Best-effort: startApproval's own
    // Conditional-branch resolution can still reject after
    // resolveApprovalLevels already found a definition (e.g. a branch
    // whose conditions don't match this exact context) — Journal's own
    // local approve/reject flow (approveJournal/rejectJournal) works
    // completely unaffected either way.
    if (resolvedApprovalLevels) {
      try {
        const request = await ApprovalWorkflowService.startApproval({
          module: "Journal", entityId: journal._id, entityRef: journalNumber, context: { amount: debitTotal, journalType }
        }, tenantId, userId);
        journal.approvalRequestId = request._id;
        await journal.save();
      } catch {
        // No real definition matched after all — journal.approvalRequestId stays null.
      }
    }

    await AuditLogModel.create({
      action: "finance.journal.create",
      module: "Finance",
      resource: "Journal",
      resourceId: journal._id.toString(),
      userId: userId || null,
      tenantId,
      details: { journalNumber: journal.journalNumber, debitTotal, creditTotal }
    });

    publishEvent("JournalCreated", { tenantId, journalId: journal._id.toString(), journalNumber: journal.journalNumber, performedBy: userId || null });
    if (possibleDuplicateOfJournalId) {
      publishEvent("PossibleDuplicateJournalDetected", { tenantId, journalId: journal._id.toString(), possibleDuplicateOfJournalId: possibleDuplicateOfJournalId.toString(), performedBy: userId || null });
    }
    if (journalType === "Revenue Recognition") {
      publishEvent("RevenueRecognitionJournalCreated", { tenantId, journalId: journal._id.toString(), journalNumber: journal.journalNumber, performedBy: userId || null });
    }

    return journal.toJSON();
  }

  /**
   * PATCH /api/v1/journals/:journalId — Draft only.
   * Editable fields: description, postingDate, lines, attachments, remarks.
   */
  static async updateJournal(journalId, data, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");
    assertJournalEditable(journal);

    // "Version Conflict Check" (Part 40, item 39) — real optimistic
    // concurrency: a caller that read the journal at version N and now
    // supplies expectedVersion: N is rejected if someone else's edit has
    // already moved it past N. Omitting expectedVersion (the field is
    // optional) skips the check entirely — a deliberate, backward-
    // compatible opt-in, not a breaking change to existing callers.
    if (data?.expectedVersion !== undefined && data.expectedVersion !== journal.version) {
      throw new Error(`Version conflict: expected version ${data.expectedVersion} but the journal is now at version ${journal.version}.`);
    }

    const { description, postingDate, lines: rawLines, attachments, remarks } = data;
    const changedFields = {};

    if (description !== undefined) changedFields.description = description;
    if (attachments !== undefined) changedFields.attachments = attachments;
    if (remarks !== undefined) changedFields.remarks = remarks;

    let nextPostingDate = journal.postingDate;
    if (postingDate !== undefined) {
      nextPostingDate = new Date(postingDate);
      changedFields.postingDate = nextPostingDate;
      changedFields.financialYear = `${nextPostingDate.getUTCFullYear()}`;
    }

    if (postingDate !== undefined || rawLines !== undefined) {
      await FinancialPeriodService.assertPeriodOpen(tenantId, nextPostingDate);
    }

    if (rawLines !== undefined) {
      const { lines, accounts } = await JournalService._resolveAccountsForLines(rawLines, tenantId, { journalType: journal.journalType, currency: journal.currency });
      const { debitTotal, creditTotal } = validateDoubleEntryLines(lines);
      assertRevenueRecognitionJournal(journal.journalType, accounts);
      changedFields.lines = lines;
      changedFields.debitTotal = debitTotal;
      changedFields.creditTotal = creditTotal;
    }

    if (Object.keys(changedFields).length === 0) return JournalService._withCheapJournalFields(journal.toJSON());

    changedFields.updatedBy = userId || null;
    changedFields.version = journal.version + 1;
    Object.assign(journal, changedFields);
    await journal.save();

    await AuditLogModel.create({
      action: "finance.journal.update",
      module: "Finance",
      resource: "Journal",
      resourceId: journal._id.toString(),
      userId: userId || null,
      tenantId,
      details: { changedFields: Object.keys(changedFields) }
    });

    publishEvent("JournalUpdated", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

    return journal.toJSON();
  }

  /**
   * "Approval Workflow Integration" (Part 40, item 37) — best-effort
   * mirror of a Journal-level decision onto its real ApprovalRequestModel
   * (when one exists), the identical pattern Part 35 already proved for
   * Expense. A failure here (e.g. the acting user isn't one of the real
   * request's assigned approvers) is expected and silently ignored — it
   * never blocks or reverses the real decision already recorded on the
   * journal itself.
   */
  static async _mirrorDecisionToApprovalRequest(journal, decision, tenantId, userId) {
    if (!journal.approvalRequestId) return;
    try {
      await ApprovalWorkflowService.recordDecision(journal.approvalRequestId, { decision }, tenantId, userId);
    } catch {
      // Expected when this approver isn't resolvable on the real request — see doc comment above.
    }
  }

  static async _closeApprovalRequest(journal, reason, tenantId, userId) {
    if (!journal.approvalRequestId) return;
    try {
      const request = await ApprovalWorkflowService.getApprovalRequestById(journal.approvalRequestId, tenantId);
      if (["Pending", "Escalated"].includes(request.status)) {
        await ApprovalWorkflowService.cancelApprovalRequest(journal.approvalRequestId, { reason }, tenantId, userId);
      }
    } catch {
      // Already resolved/cancelled, or not found — nothing to close.
    }
  }

  /**
   * POST /api/v1/journals/:journalId/approve
   * Bridges the spec's Draft -> Pending Approval -> Approved chain: no
   * separate "submit for approval" endpoint was contracted, so approve is
   * valid directly from Draft as well as from Pending Approval.
   */
  static async approveJournal(journalId, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");
    if (!["Draft", "Pending Approval"].includes(journal.status)) {
      throw new Error(`Journal cannot be approved from status "${journal.status}".`);
    }

    journal.status = "Approved";
    journal.approvedBy = userId || null;
    journal.approvedAt = new Date();
    journal.updatedBy = userId || null;
    await journal.save();
    await JournalService._mirrorDecisionToApprovalRequest(journal, "Approved", tenantId, userId);

    await AuditLogModel.create({ action: "finance.journal.approve", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("JournalApproved", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

    return journal.toJSON();
  }

  /**
   * POST /api/v1/journals/:journalId/reject — gap-fill: the spec's own
   * Journal Lifecycle diagram names a "Rejected" alternative flow and
   * `JournalRejected` domain event, but no endpoint contract was given to
   * reach it. Added so both are actually reachable.
   */
  static async rejectJournal(journalId, data, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");
    if (!["Draft", "Pending Approval"].includes(journal.status)) {
      throw new Error(`Journal cannot be rejected from status "${journal.status}".`);
    }
    if (!data?.reason) throw new Error("A rejection reason is required.");

    journal.status = "Rejected";
    journal.rejectedBy = userId || null;
    journal.rejectedAt = new Date();
    journal.rejectionReason = data.reason;
    journal.updatedBy = userId || null;
    await journal.save();
    await JournalService._mirrorDecisionToApprovalRequest(journal, "Rejected", tenantId, userId);

    await AuditLogModel.create({ action: "finance.journal.reject", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: { reason: data.reason } });
    publishEvent("JournalRejected", { tenantId, journalId: journal._id.toString(), performedBy: userId || null, reason: data.reason });

    return journal.toJSON();
  }

  /**
   * POST /api/v1/journals/:journalId/cancel — gap-fill for the Lifecycle
   * diagram's "Cancelled" alternative flow (Draft/Pending Approval/Approved
   * only; a Posted journal is irreversible and must be reversed instead).
   */
  static async cancelJournal(journalId, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");
    if (!["Draft", "Pending Approval", "Approved"].includes(journal.status)) {
      throw new Error(`Journal cannot be cancelled from status "${journal.status}". Posted journals must be reversed, not cancelled.`);
    }

    journal.status = "Cancelled";
    journal.cancelledBy = userId || null;
    journal.cancelledAt = new Date();
    journal.updatedBy = userId || null;
    await journal.save();
    await JournalService._closeApprovalRequest(journal, "Journal cancelled.", tenantId, userId);

    await AuditLogModel.create({ action: "finance.journal.cancel", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("JournalCancelled", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

    return journal.toJSON();
  }

  /**
   * POST /api/v1/journals/:journalId/archive — "Archiving Strategy" (File
   * 2, Journal Platform Part 4, item 50). "Archived" already existed as a
   * real, configured status value with no reachable endpoint until now —
   * the same kind of pre-existing gap Part 36 found and closed for Chart
   * of Accounts. A real, reversible status transition (see restoreJournal
   * below) — never a delete; the journal and its full Ledger history stay
   * exactly as they were.
   */
  static async archiveJournal(journalId, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");
    assertCanArchive(journal);

    journal.status = "Archived";
    journal.archivedBy = userId || null;
    journal.archivedAt = new Date();
    journal.updatedBy = userId || null;
    await journal.save();

    await AuditLogModel.create({ action: "finance.journal.archive", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("JournalArchived", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

    return journal.toJSON();
  }

  /**
   * POST /api/v1/journals/:journalId/restore — the real, symmetric
   * complement to archiveJournal ("Restorable" in the spec's own
   * lifecycle diagram). Archived -> Posted only.
   */
  static async restoreJournal(journalId, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");
    assertCanRestore(journal);

    journal.status = "Posted";
    journal.restoredBy = userId || null;
    journal.restoredAt = new Date();
    journal.updatedBy = userId || null;
    await journal.save();

    await AuditLogModel.create({ action: "finance.journal.restore", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("JournalRestored", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

    return journal.toJSON();
  }

  /**
   * POST /api/v1/journals/:journalId/post
   * Validate Approval -> Validate Financial Period -> Lock Journal ->
   * Generate Ledger Entries -> Generate Audit -> Publish JournalPosted.
   * "Posting irreversible" — corrections happen only via reverseJournal.
   */
  static async postJournal(journalId, tenantId, userId) {
    const config = getFinanceConfig();
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");

    if (!isPostableStatus(journal.status, config.journalApprovalRequired)) {
      throw new Error(`Journal cannot be posted from status "${journal.status}".${config.journalApprovalRequired ? " It must be Approved first." : ""}`);
    }

    // Re-checked here, not just at creation — the period may have closed
    // between creation/approval and posting.
    await FinancialPeriodService.assertPeriodOpen(tenantId, journal.postingDate);

    // "Posting Validation Engine" (File 2 Part 2, item 13) — re-verify
    // Accounts Active/Posting Restrictions and Exchange Rate Exists right
    // before posting, not just at creation time.
    await JournalService._assertLinesPostable(journal.lines, tenantId, { journalType: journal.journalType, currency: journal.currency });
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    if (journal.currency.toUpperCase() !== baseCurrency.toUpperCase()) {
      await CurrencyService.getRate(tenantId, journal.currency, baseCurrency);
    }

    await LedgerService.postJournalEntries(journal, tenantId, userId);

    journal.status = "Posted";
    journal.postedBy = userId || null;
    journal.postedAt = new Date();
    journal.updatedBy = userId || null;
    await journal.save();

    await AuditLogModel.create({ action: "finance.journal.post", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: { journalNumber: journal.journalNumber } });
    publishEvent("JournalPosted", { tenantId, journalId: journal._id.toString(), journalNumber: journal.journalNumber, performedBy: userId || null });

    return journal.toJSON();
  }

  /**
   * POST /api/v1/journals/:journalId/reverse
   * "Corrections are performed through reversing journals; original journal
   * always preserved." Creates and immediately posts a new journal type
   * "Reversal" with each line's debit/credit swapped, then links both
   * journals. Supports a full reversal (default) or a partial reversal via
   * `lines: [{ lineId, amount }]` in the request body.
   */
  static async reverseJournal(journalId, data, tenantId, userId) {
    const original = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!original) throw new Error("Journal not found.");
    if (original.status !== "Posted") throw new Error("Only Posted journals can be reversed.");
    if (original.isReversed) throw new Error("This journal has already been reversed.");

    const postingDate = data?.postingDate ? new Date(data.postingDate) : new Date();
    await FinancialPeriodService.assertPeriodOpen(tenantId, postingDate);

    const sourceLines = Array.isArray(data?.lines) && data.lines.length > 0
      ? data.lines.map((override) => {
          const originalLine = original.lines.find((line) => line._id.toString() === override.lineId);
          if (!originalLine) throw new Error(`Reversal references an unknown original line id: ${override.lineId}`);
          const amount = roundCurrency(override.amount);
          if (amount <= 0) throw new Error("Partial reversal amount must be greater than zero.");
          const originalAmount = originalLine.debit || originalLine.credit;
          if (amount > originalAmount) throw new Error(`Partial reversal amount for line ${override.lineId} exceeds the original posted amount.`);
          return {
            accountId: originalLine.accountId,
            accountCode: originalLine.accountCode,
            debit: originalLine.credit ? amount : 0,
            credit: originalLine.debit ? amount : 0,
            description: `Reversal of ${original.journalNumber}`
          };
        })
      : original.lines.map((line) => ({
          accountId: line.accountId,
          accountCode: line.accountCode,
          debit: line.credit,
          credit: line.debit,
          description: `Reversal of ${original.journalNumber}`
        }));

    const { debitTotal, creditTotal } = validateDoubleEntryLines(sourceLines);

    const financialYear = `${postingDate.getUTCFullYear()}`;
    const journalNumber = await JournalService._generateJournalNumber(tenantId, financialYear);

    const reversal = await JournalModel.create({
      tenantId,
      journalNumber,
      journalType: "Reversal",
      status: "Approved",
      postingDate,
      financialYear,
      description: data?.description || `Reversal of ${original.journalNumber}`,
      referenceNumber: original.journalNumber,
      currency: original.currency,
      lines: sourceLines,
      debitTotal,
      creditTotal,
      reversalOf: original._id,
      createdBy: userId || null,
      updatedBy: userId || null,
      approvedBy: userId || null,
      approvedAt: new Date()
    });

    await JournalService._assertLinesPostable(reversal.lines, tenantId, { journalType: reversal.journalType, currency: reversal.currency });
    await LedgerService.postJournalEntries(reversal, tenantId, userId);
    reversal.status = "Posted";
    reversal.postedBy = userId || null;
    reversal.postedAt = new Date();
    await reversal.save();

    original.isReversed = true;
    original.reversedBy = reversal._id;
    original.updatedBy = userId || null;
    await original.save();

    await AuditLogModel.create({
      action: "finance.journal.reverse",
      module: "Finance",
      resource: "Journal",
      resourceId: original._id.toString(),
      userId: userId || null,
      tenantId,
      details: { reversalJournalId: reversal._id.toString(), reversalJournalNumber: reversal.journalNumber }
    });
    publishEvent("JournalReversed", { tenantId, originalJournalId: original._id.toString(), reversalJournalId: reversal._id.toString(), performedBy: userId || null });

    return { original: original.toJSON(), reversal: reversal.toJSON() };
  }

  /**
   * POST /api/v1/journals/:journalId/correct — "Correction Journals" (File
   * 2 Part 2, item 21). Unlike reverseJournal (which always posts the
   * exact opposite of the original), a correction posts a NEW,
   * caller-supplied set of correct entries — journalType "Adjustment", a
   * real, already-existing journalType, reused rather than fabricating a
   * new "Correction" one — referencing the original for a full audit
   * trail. The original remains fully immutable and queryable; only
   * `isCorrected`/`correctedBy` are set on it.
   */
  static async correctJournal(journalId, data, tenantId, userId) {
    const original = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!original) throw new Error("Journal not found.");
    assertCanCorrect(original);

    const rawLines = data?.lines;
    if (!Array.isArray(rawLines) || rawLines.length < 2) throw new Error("A correction journal requires at least two lines.");

    const postingDate = data?.postingDate ? new Date(data.postingDate) : new Date();
    await FinancialPeriodService.assertPeriodOpen(tenantId, postingDate);

    const { lines, accounts } = await JournalService._resolveAccountsForLines(rawLines, tenantId, { journalType: "Adjustment", currency: original.currency });
    const { debitTotal, creditTotal } = validateDoubleEntryLines(lines);
    assertRevenueRecognitionJournal("Adjustment", accounts);

    const financialYear = `${postingDate.getUTCFullYear()}`;
    const journalNumber = await JournalService._generateJournalNumber(tenantId, financialYear);

    const correction = await JournalModel.create({
      tenantId,
      journalNumber,
      journalType: "Adjustment",
      status: "Approved",
      postingDate,
      financialYear,
      description: data?.description || `Correction of ${original.journalNumber}`,
      referenceNumber: original.journalNumber,
      currency: original.currency,
      lines,
      debitTotal,
      creditTotal,
      correctionOf: original._id,
      createdBy: userId || null,
      updatedBy: userId || null,
      approvedBy: userId || null,
      approvedAt: new Date()
    });

    await JournalService._assertLinesPostable(correction.lines, tenantId, { journalType: correction.journalType, currency: correction.currency });
    await LedgerService.postJournalEntries(correction, tenantId, userId);
    correction.status = "Posted";
    correction.postedBy = userId || null;
    correction.postedAt = new Date();
    await correction.save();

    original.isCorrected = true;
    original.correctedBy = correction._id;
    original.updatedBy = userId || null;
    await original.save();

    await AuditLogModel.create({
      action: "finance.journal.correct",
      module: "Finance",
      resource: "Journal",
      resourceId: original._id.toString(),
      userId: userId || null,
      tenantId,
      details: { correctionJournalId: correction._id.toString(), correctionJournalNumber: correction.journalNumber }
    });
    publishEvent("JournalCorrected", { tenantId, originalJournalId: original._id.toString(), correctionJournalId: correction._id.toString(), performedBy: userId || null });

    return { original: original.toJSON(), correction: correction.toJSON() };
  }

  /**
   * GET /api/v1/journals/:journalId/history — "Journal Versioning" (File 2
   * Part 2, item 22). Not a fabricated version-number/snapshot field —
   * journals are immutable once posted, so each correction/reversal is
   * already its own real, separately posted document. This walks the real
   * reversalOf/correctionOf chain from any journal in it back to the root
   * original, then forward through every linked reversal/correction,
   * oldest first.
   */
  static async getJournalHistory(journalId, tenantId) {
    let current = await JournalModel.findOne({ _id: journalId, tenantId }).lean();
    if (!current) throw new Error("Journal not found.");

    while (current.reversalOf || current.correctionOf) {
      const parentId = current.reversalOf || current.correctionOf;
      const parent = await JournalModel.findOne({ _id: parentId, tenantId }).lean();
      if (!parent) break;
      current = parent;
    }
    const root = current;

    const chain = [root];
    let cursor = root;
    while (cursor.reversedBy || cursor.correctedBy) {
      const nextId = cursor.reversedBy || cursor.correctedBy;
      const next = await JournalModel.findOne({ _id: nextId, tenantId }).lean();
      if (!next) break;
      chain.push(next);
      cursor = next;
    }

    return chain;
  }

  // ---------------------------------------------------------------------
  // Journal Templates — File 2, Journal Platform Part 2, item 18.
  // ---------------------------------------------------------------------

  static async listJournalTemplates(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    return JournalTemplateModel.find(filter).sort({ name: 1 }).lean();
  }

  static async getJournalTemplateById(templateId, tenantId) {
    const template = await JournalTemplateModel.findOne({ tenantId, templateId }).lean();
    if (!template) throw new Error("Journal template not found.");
    return template;
  }

  static async createJournalTemplate(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, description = null, journalType = config.defaultJournalType, currency = null, lineBlueprints = [] } = data;
    if (!name) throw new Error("name is required.");
    if (!config.journalTypes.includes(journalType)) throw new Error(`Invalid journalType "${journalType}".`);
    if (!Array.isArray(lineBlueprints) || lineBlueprints.length < 2) throw new Error("lineBlueprints must contain at least two lines.");

    // Every blueprint account must be real, already-existing for this
    // tenant — never a fabricated/dangling accountCode reference.
    for (const blueprint of lineBlueprints) {
      if (!blueprint.accountCode) throw new Error("Each line blueprint requires an accountCode.");
      const account = await ChartOfAccountModel.findOne({ tenantId, accountCode: blueprint.accountCode }).lean();
      if (!account) throw new Error(`Account not found: ${blueprint.accountCode}`);
    }

    const templateId = JournalService._generateTemplateId();
    const template = await JournalTemplateModel.create({
      tenantId, templateId, name, description, journalType, currency, lineBlueprints, status: "Active",
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.journal.create_template", module: "Finance", resource: "JournalTemplate", resourceId: template._id.toString(), userId: userId || null, tenantId, details: { templateId, name } });
    publishEvent("JournalTemplateCreated", { tenantId, templateId, name, performedBy: userId || null });

    return template.toJSON();
  }

  /**
   * POST /api/v1/journal-templates/:templateId/apply — the template's own
   * lineBlueprints seed the request; `lineOverrides[index]` lets the
   * caller supply a different real amount/description/dimensions for that
   * line (a reusable template's whole point is the same account structure
   * applied with a different real amount each time — e.g. a different
   * month's rent). Delegates entirely to the real createJournal — an
   * applied template is a completely ordinary journal in every other
   * respect (same validation, same duplicate detection, same events).
   */
  static async applyJournalTemplate(templateId, data, tenantId, userId) {
    const template = await JournalService.getJournalTemplateById(templateId, tenantId);
    if (template.status !== "Active") throw new Error(`Journal template is not Active (status: "${template.status}").`);

    const overrides = Array.isArray(data?.lineOverrides) ? data.lineOverrides : [];
    const lines = template.lineBlueprints.map((blueprint, index) => {
      const override = overrides[index] || {};
      return {
        accountCode: blueprint.accountCode,
        description: override.description || blueprint.description || null,
        debit: override.debit !== undefined ? override.debit : blueprint.debit,
        credit: override.credit !== undefined ? override.credit : blueprint.credit,
        dimensions: override.dimensions || blueprint.dimensions || {}
      };
    });

    const journal = await JournalService.createJournal({
      journalType: data?.journalType || template.journalType,
      postingDate: data?.postingDate || new Date(),
      description: data?.description || template.description || `Applied from template "${template.name}"`,
      referenceNumber: data?.referenceNumber || null,
      currency: data?.currency || template.currency || undefined,
      lines,
      sourceModule: data?.sourceModule || null,
      sourceEntity: "JournalTemplate",
      sourceId: template.templateId,
      correlationId: data?.correlationId || null
    }, tenantId, userId);

    publishEvent("JournalTemplateApplied", { tenantId, templateId: template.templateId, journalId: journal._id, performedBy: userId || null });

    return journal;
  }

  // ---------------------------------------------------------------------
  // Recurring Journals — File 2, Journal Platform Part 2, item 19.
  // Real cron-based generation, see services/recurringJournalScheduler.js.
  // ---------------------------------------------------------------------

  static async createRecurringJournal(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, description = null, templateId, frequency, customIntervalDays = null, nextRunDate, endDate = null } = data;
    if (!name) throw new Error("name is required.");
    if (!templateId) throw new Error("templateId is required.");
    if (!config.recurringJournalFrequencies.includes(frequency)) throw new Error(`Invalid frequency "${frequency}".`);
    if (!nextRunDate) throw new Error("nextRunDate is required.");

    // Real, already-existing template only — never a dangling reference.
    await JournalService.getJournalTemplateById(templateId, tenantId);

    const recurring = await RecurringJournalModel.create({
      tenantId, name, description, templateId, frequency, customIntervalDays,
      nextRunDate: new Date(nextRunDate), endDate: endDate ? new Date(endDate) : null,
      status: "Active", createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.journal.create_recurring", module: "Finance", resource: "RecurringJournal", resourceId: recurring._id.toString(), userId: userId || null, tenantId, details: { templateId, frequency } });
    publishEvent("RecurringJournalCreated", { tenantId, recurringJournalId: recurring._id.toString(), templateId, frequency, performedBy: userId || null });

    return recurring.toJSON();
  }

  static async listRecurringJournals(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    return RecurringJournalModel.find(filter).sort({ nextRunDate: 1 }).lean();
  }

  static async getRecurringJournalById(recurringJournalId, tenantId) {
    const recurring = await RecurringJournalModel.findOne({ _id: recurringJournalId, tenantId }).lean();
    if (!recurring) throw new Error("Recurring journal not found.");
    return recurring;
  }

  static async setRecurringJournalStatus(recurringJournalId, status, tenantId, userId) {
    const recurring = await RecurringJournalModel.findOne({ _id: recurringJournalId, tenantId });
    if (!recurring) throw new Error("Recurring journal not found.");
    recurring.status = status;
    recurring.updatedBy = userId || null;
    await recurring.save();
    publishEvent("RecurringJournalStatusChanged", { tenantId, recurringJournalId: recurring._id.toString(), status, performedBy: userId || null });
    return recurring.toJSON();
  }

  /**
   * Called by recurringJournalScheduler.js on its cron tick. Real,
   * per-item error tolerance (one broken recurring definition never blocks
   * the rest) — the same discipline JournalBatch's own partial-failure
   * handling uses below.
   */
  static async runDueRecurringJournals(now = new Date()) {
    const due = await RecurringJournalModel.find({
      status: "Active",
      nextRunDate: { $lte: now },
      $or: [{ endDate: null }, { endDate: { $gte: now } }]
    });

    let generatedCount = 0;
    for (const recurring of due) {
      try {
        const journal = await JournalService.applyJournalTemplate(recurring.templateId, { postingDate: now, sourceEntity: "RecurringJournal", sourceId: recurring._id.toString() }, recurring.tenantId, "system");
        await JournalModel.updateOne({ _id: journal._id }, { $set: { recurringJournalId: recurring._id } });

        recurring.lastRunDate = now;
        recurring.lastGeneratedJournalId = journal._id;
        recurring.runCount += 1;
        recurring.nextRunDate = computeNextRunDate(now, recurring.frequency, recurring.customIntervalDays);
        if (recurring.endDate && recurring.nextRunDate > recurring.endDate) recurring.status = "Completed";
        await recurring.save();

        publishEvent("RecurringJournalGenerated", { tenantId: recurring.tenantId, recurringJournalId: recurring._id.toString(), journalId: journal._id.toString(), performedBy: "system" });
        generatedCount += 1;
      } catch (error) {
        logger.error("Recurring journal generation failed.", { recurringJournalId: recurring._id.toString(), tenantId: recurring.tenantId, error: error.message });
      }
    }

    return generatedCount;
  }

  // ---------------------------------------------------------------------
  // Batch Journal Processing — File 2, Journal Platform Part 2, item 14.
  // Real, synchronous batch creation — see models/JournalBatchModel.js's
  // own note on why no queue/worker-pool infrastructure was fabricated.
  // ---------------------------------------------------------------------

  static async createJournalBatch(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { batchType, journals: journalSpecs, autoPost = false } = data;
    if (!batchType || !config.journalBatchTypes.includes(batchType)) throw new Error(`Invalid batchType "${batchType}".`);
    if (!Array.isArray(journalSpecs) || journalSpecs.length === 0) throw new Error("journals must be a non-empty array.");

    const batchNumber = await JournalService._generateBatchNumber(tenantId);
    const batch = await JournalBatchModel.create({ tenantId, batchNumber, batchType, status: "Processing", totalCount: journalSpecs.length, createdBy: userId || null });

    publishEvent("JournalBatchCreated", { tenantId, batchId: batch._id.toString(), batchNumber, batchType, totalCount: journalSpecs.length, performedBy: userId || null });

    const journalIds = [];
    const errors = [];
    for (let index = 0; index < journalSpecs.length; index += 1) {
      try {
        let journal = await JournalService.createJournal({ ...journalSpecs[index], sourceModule: journalSpecs[index].sourceModule || null }, tenantId, userId);
        // Approval is never bypassed by a batch — only journals already
        // eligible to post (per the tenant's own journalApprovalRequired
        // gate) are actually posted; the rest are left Draft/Pending
        // Approval for a human to approve normally.
        if (autoPost && isPostableStatus(journal.status, config.journalApprovalRequired)) {
          journal = await JournalService.postJournal(journal._id, tenantId, userId);
        }
        await JournalModel.updateOne({ _id: journal._id, tenantId }, { $set: { batchId: batch._id } });
        journalIds.push(journal._id);
      } catch (error) {
        errors.push({ index, message: error.message });
      }
    }

    batch.journalIds = journalIds;
    batch.succeededCount = journalIds.length;
    batch.failedCount = errors.length;
    batch.failedItems = errors;
    batch.status = errors.length === 0 ? "Completed" : (journalIds.length === 0 ? "Failed" : "PartiallyCompleted");
    batch.completedAt = new Date();
    await batch.save();

    await AuditLogModel.create({ action: "finance.journal.batch_create", module: "Finance", resource: "JournalBatch", resourceId: batch._id.toString(), userId: userId || null, tenantId, details: { batchType, totalCount: journalSpecs.length, succeededCount: journalIds.length, failedCount: errors.length } });
    publishEvent("JournalBatchCompleted", { tenantId, batchId: batch._id.toString(), batchNumber, succeededCount: journalIds.length, failedCount: errors.length, performedBy: userId || null });

    return batch.toJSON();
  }

  static async listJournalBatches(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.batchType) filter.batchType = query.batchType;
    return JournalBatchModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getJournalBatchById(batchId, tenantId) {
    const batch = await JournalBatchModel.findOne({ _id: batchId, tenantId }).lean();
    if (!batch) throw new Error("Journal batch not found.");
    return batch;
  }

  // ---------------------------------------------------------------------
  // Revenue Recognition — File 2, Journal Platform Part 3, item 31.
  // "Find Contracts -> Find Deferred Revenue -> Calculate Earned Revenue"
  // (automatic contract discovery/calculation) is NOT built — no
  // Subscription/AMC/License/Insurance/Hosting/Maintenance/Professional-
  // Services contract entity exists anywhere in this codebase to find or
  // calculate earned revenue against (the same real gap Part 37 already
  // named when it built revenueRecognition as declarative metadata only).
  // This is the real, honest form: a thin, manually-triggered wrapper
  // around the already-real "Revenue Recognition" journalType (Part
  // 38/39), for a caller who has already determined the real amount to
  // recognize this period.
  // ---------------------------------------------------------------------

  static async createRevenueRecognitionJournal(data, tenantId, userId) {
    publishEvent("RevenueRecognitionStarted", { tenantId, performedBy: userId || null });
    const journal = await JournalService.createJournal({ ...data, journalType: "Revenue Recognition" }, tenantId, userId);
    publishEvent("RevenueRecognitionCompleted", { tenantId, journalId: journal._id, journalNumber: journal.journalNumber, performedBy: userId || null });
    return journal;
  }

  // ---------------------------------------------------------------------
  // Journal Search — File 2, Journal Platform Part 3, item 34. A real thin
  // wrapper over the already-real, already-Journal-indexing
  // SearchEngineService.globalSearch (Part 28) — full text/partial/fuzzy
  // search all already work exactly this way for every other indexed
  // entity in this codebase; not reimplemented here. "Saved Searches" also
  // already exist and are entity-agnostic (POST/GET/DELETE
  // /api/v1/search/saved) — no new code needed for that either. Branch/
  // Merchant/Subscription filters were dropped (no backing dimension);
  // Department/CostCenter live on journal LINES, not the header, so
  // aren't exposed as a top-level filter here.
  // ---------------------------------------------------------------------

  static async searchJournals(query, tenantId, permissions = []) {
    const { q = "", status, currency, dateFrom, dateTo, page = 1, pageSize = 20, sort = "score", order = "desc" } = query;
    return SearchEngineService.globalSearch({
      tenantId, query: q, entityType: "JournalEntry", permissions,
      filters: { status, currency, dateFrom, dateTo },
      page, pageSize, sort, order
    });
  }

  // ---------------------------------------------------------------------
  // Journal Statistics — File 2, Journal Platform Part 3, item 35. Real,
  // live aggregation (no persisted, scheduler-refreshed summary table was
  // built — a live query is right-sized for this ask, unlike Part 25's
  // KPIEngine summary, which exists because its own dashboard queries are
  // genuinely expensive at scale). "Failed Posting"/"Queue Size" are
  // omitted — no async posting-failure state or queue exists to count (see
  // docs/05-api/07-finance-api.md Part 40's own "explicitly out of scope"
  // note); "Merchant Journals"/"Subscription Journals" are omitted for the
  // same reason as everywhere else in this session — no backing entity.
  // ---------------------------------------------------------------------

  static async getJournalStatistics(tenantId) {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const [
      totalJournals, postedToday, pendingApproval, reversedJournals, correctionJournals, postedForAvgTiming
    ] = await Promise.all([
      JournalModel.countDocuments({ tenantId }),
      JournalModel.countDocuments({ tenantId, status: "Posted", postedAt: { $gte: startOfToday } }),
      JournalModel.countDocuments({ tenantId, status: "Pending Approval" }),
      JournalModel.countDocuments({ tenantId, isReversed: true }),
      JournalModel.countDocuments({ tenantId, isCorrected: true }),
      JournalModel.find({ tenantId, status: "Posted", postedAt: { $ne: null } }).select("createdAt postedAt").limit(1000).lean()
    ]);

    const postingDurationsMs = postedForAvgTiming
      .map((j) => new Date(j.postedAt).getTime() - new Date(j.createdAt).getTime())
      .filter((ms) => ms >= 0);
    const averagePostingTimeMs = postingDurationsMs.length > 0
      ? Math.round(postingDurationsMs.reduce((sum, ms) => sum + ms, 0) / postingDurationsMs.length)
      : null;

    return { totalJournals, postedToday, pendingApproval, reversedJournals, correctionJournals, averagePostingTimeMs };
  }

  // ---------------------------------------------------------------------
  // Journal Attachment Support — File 2, Journal Platform Part 3, item 36.
  // Real multer upload + real SHA-256 checksum of the actual uploaded
  // bytes + real storage via storeDocumentPdf — the identical real
  // pattern ExpenseService.uploadReceipt already uses (crypto.createHash,
  // Part 35). Deliberately allowed regardless of the journal's own
  // status — a supporting document (bank advice, settlement report) is
  // often only available after posting, and attaching one is additive
  // metadata, never a change to the immutable financial facts.
  // ---------------------------------------------------------------------

  static async addJournalAttachment(journalId, file, tenantId, userId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId });
    if (!journal) throw new Error("Journal not found.");

    const checksum = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const stored = await storeDocumentPdf({
      tenantId, folder: "journal-attachments",
      filename: `${journal.journalNumber}-${Date.now()}-${(file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      buffer: file.buffer
    });

    const attachment = { url: stored.url, filename: file.originalname || "attachment", contentType: file.mimetype || null, checksum, uploadedBy: userId || null, uploadedAt: new Date() };
    journal.attachments.push(attachment);
    journal.updatedBy = userId || null;
    await journal.save();

    const savedAttachment = journal.attachments[journal.attachments.length - 1];

    await AuditLogModel.create({ action: "finance.journal.attachment_add", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: { filename: attachment.filename, checksum } });
    publishEvent("JournalAttachmentAdded", { tenantId, journalId: journal._id.toString(), attachmentId: savedAttachment._id.toString(), filename: attachment.filename, performedBy: userId || null });

    return savedAttachment.toJSON ? savedAttachment.toJSON() : savedAttachment;
  }

  // ---------------------------------------------------------------------
  // Journal Import — File 2, Journal Platform Part 3, item 28. Real
  // CSV/Excel (csv-parse/exceljs, the same libraries
  // services/reconciliationParsers/ already uses for Bank Reconciliation
  // import) plus JSON. SAP/Oracle/QuickBooks/Xero export formats were
  // dropped — no real parser for any of them exists anywhere in this
  // codebase. Each row is one journal LINE; rows sharing the same
  // `reference` value are grouped into one journal (Custom Mapping lets a
  // caller's own column names be remapped to the real field names below).
  // ---------------------------------------------------------------------

  static _parseImportRows(buffer, format) {
    if (format === "CSV") {
      try {
        return parseCsv(buffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true, bom: true });
      } catch (error) {
        throw new Error(`Failed to parse CSV file: ${error.message}`);
      }
    }
    if (format === "JSON") {
      let parsed;
      try {
        parsed = JSON.parse(buffer.toString("utf8"));
      } catch (error) {
        throw new Error(`Failed to parse JSON file: ${error.message}`);
      }
      if (!Array.isArray(parsed)) throw new Error("JSON import must be an array of row objects.");
      return parsed;
    }
    throw new Error(`Unsupported import format "${format}". Use previewJournalImport/importJournals's async Excel path for "Excel".`);
  }

  static async _parseImportRowsAsync(buffer, format) {
    if (format !== "Excel") return JournalService._parseImportRows(buffer, format);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch (error) {
      throw new Error(`Failed to parse Excel file: ${error.message}`);
    }
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("Excel file has no worksheets.");

    const headerValues = worksheet.getRow(1).values;
    const headers = (Array.isArray(headerValues) ? headerValues.slice(1) : []).map((h) => String(h || "").trim());

    const rows = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = (Array.isArray(row.values) ? row.values.slice(1) : []);
      const record = {};
      headers.forEach((header, index) => { if (header) record[header] = values[index]; });
      rows.push(record);
    });
    return rows;
  }

  static _applyImportMapping(row, mapping = {}) {
    const field = (key) => row[mapping[key] || key];
    return {
      reference: field("reference"),
      postingDate: field("postingDate"),
      accountCode: field("accountCode"),
      debit: field("debit"),
      credit: field("credit"),
      description: field("description"),
      currency: field("currency")
    };
  }

  static _groupImportRowsIntoJournals(rows, mapping, defaultCurrency) {
    const mapped = rows.map((row) => JournalService._applyImportMapping(row, mapping));
    const groups = new Map();
    mapped.forEach((row, index) => {
      if (!row.reference) throw new Error(`Import row ${index + 1} is missing a reference value to group lines into a journal.`);
      if (!groups.has(row.reference)) groups.set(row.reference, []);
      groups.get(row.reference).push(row);
    });

    return Array.from(groups.entries()).map(([reference, groupRows]) => ({
      referenceNumber: String(reference),
      postingDate: groupRows[0].postingDate,
      currency: groupRows[0].currency || defaultCurrency,
      description: `Imported journal ${reference}`,
      lines: groupRows.map((r) => ({ accountCode: r.accountCode, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0, description: r.description || null }))
    }));
  }

  /**
   * POST /api/v1/journals/import/preview — parses + groups + validates
   * (double-entry balance, real account existence via a dry-run of
   * _resolveAccountsForLines) WITHOUT persisting anything. Real
   * "Preview" step between Mapping and Approval in the spec's own
   * workflow.
   */
  static async previewJournalImport(buffer, format, mapping, tenantId) {
    const config = getFinanceConfig();
    if (!config.journalImportFormats.includes(format)) throw new Error(`Invalid import format "${format}".`);

    const rows = await JournalService._parseImportRowsAsync(buffer, format);
    const candidates = JournalService._groupImportRowsIntoJournals(rows, mapping || {}, config.defaultCurrency);

    const preview = [];
    for (const candidate of candidates) {
      try {
        const { lines } = await JournalService._resolveAccountsForLines(candidate.lines, tenantId, { journalType: "Manual", currency: candidate.currency });
        const { debitTotal, creditTotal } = validateDoubleEntryLines(lines);
        preview.push({ ...candidate, valid: true, debitTotal, creditTotal, error: null });
      } catch (error) {
        preview.push({ ...candidate, valid: false, error: error.message });
      }
    }

    return { totalCandidates: preview.length, validCount: preview.filter((p) => p.valid).length, invalidCount: preview.filter((p) => !p.valid).length, journals: preview };
  }

  /**
   * POST /api/v1/journals/import — same parse/group as the preview, then
   * actually creates each valid candidate via the real createJournal
   * (partial-failure tolerant, the same discipline as createJournalBatch).
   */
  static async importJournals(buffer, format, mapping, tenantId, userId) {
    const config = getFinanceConfig();
    if (!config.journalImportFormats.includes(format)) throw new Error(`Invalid import format "${format}".`);

    const rows = await JournalService._parseImportRowsAsync(buffer, format);
    const candidates = JournalService._groupImportRowsIntoJournals(rows, mapping || {}, config.defaultCurrency);
    if (candidates.length === 0) throw new Error("No importable journals were found in the file.");

    const journalIds = [];
    const errors = [];
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const journal = await JournalService.createJournal({ ...candidates[index], sourceModule: "System" }, tenantId, userId);
        journalIds.push(journal._id);
      } catch (error) {
        errors.push({ index, reference: candidates[index].referenceNumber, message: error.message });
      }
    }

    await AuditLogModel.create({ action: "finance.journal.import", module: "Finance", resource: "Journal", resourceId: tenantId, userId: userId || null, tenantId, details: { format, totalCandidates: candidates.length, succeededCount: journalIds.length, failedCount: errors.length } });
    publishEvent("JournalImported", { tenantId, format, succeededCount: journalIds.length, failedCount: errors.length, journalIds: journalIds.map((id) => id.toString()), performedBy: userId || null });

    return { totalCandidates: candidates.length, succeededCount: journalIds.length, failedCount: errors.length, journalIds, failedItems: errors };
  }
}

export default JournalService;
