import mongoose from "mongoose";
import BankReconciliationModel from "../models/BankReconciliationModel.js";
import BankStatementTransactionModel from "../models/BankStatementTransactionModel.js";
import BankReconciliationExceptionModel from "../models/BankReconciliationExceptionModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import BankTransactionModel from "../models/BankTransactionModel.js";
import BankAccountService from "./BankAccountService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import getStatementParser from "./reconciliationParsers/index.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

const FILE_EXTENSIONS = { CSV: "csv", Excel: "xlsx", MT940: "sta", "CAMT.053": "xml", OFX: "ofx", Custom: "json" };

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/bankReconciliationService.test.js).
// ---------------------------------------------------------------------------

const levenshteinDistance = (a, b) => {
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
};

/** Normalized (0-1) string similarity — "Reference Match." Real Levenshtein distance, not a placeholder. */
export const computeReferenceSimilarity = (a, b) => {
  const normA = (a || "").trim().toLowerCase();
  const normB = (b || "").trim().toLowerCase();
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  const distance = levenshteinDistance(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  return Math.max(0, 1 - distance / maxLen);
};

/** "Weighted scoring supported." Normalizes a tenant's override to sum to 1 rather than trusting it blindly. */
export const normalizeMatchWeights = (weights) => {
  const amount = Number(weights?.amount) || 0;
  const date = Number(weights?.date) || 0;
  const reference = Number(weights?.reference) || 0;
  const sum = amount + date + reference;
  if (!sum) return { amount: 0.5, date: 0.3, reference: 0.2 };
  return { amount: amount / sum, date: date / sum, reference: reference / sum };
};

/**
 * "Auto Matching Rules: Amount Match, Reference Match, Date Match,
 * Tolerance Window, Currency Match, Bank Account Match. Weighted scoring
 * supported." Direction and currency are hard filters (a mismatch there
 * means these two can never be the same real-world movement, regardless of
 * how close the amount/date/reference are) — "Bank Account Match" is
 * enforced by the caller only ever passing candidates from the correct
 * account, not scored here. Returns a 0-100 score plus its breakdown.
 */
export const computeMatchScore = ({ statementTxn, erpTxn, config }) => {
  if (statementTxn.direction !== erpTxn.direction) return { score: 0, eligible: false, breakdown: { reason: "direction mismatch" } };
  if (statementTxn.currency !== erpTxn.currency) return { score: 0, eligible: false, breakdown: { reason: "currency mismatch" } };

  const tolerance = Math.max(config.reconciliationAmountTolerance, 0.01);
  const amountDiff = Math.abs(statementTxn.amount - erpTxn.amount);
  const amountScore = amountDiff === 0 ? 100 : amountDiff <= tolerance ? Math.max(0, 100 - (amountDiff / tolerance) * 40) : 0;

  const toleranceDays = Math.max(config.reconciliationDateToleranceDays, 0);
  const dayDiff = Math.abs((new Date(statementTxn.transactionDate).getTime() - new Date(erpTxn.date).getTime()) / (24 * 60 * 60 * 1000));
  const dateScore = toleranceDays === 0 ? (dayDiff === 0 ? 100 : 0) : dayDiff <= toleranceDays ? Math.max(0, 100 - (dayDiff / toleranceDays) * 100) : 0;

  const referenceScore = computeReferenceSimilarity(statementTxn.reference, erpTxn.description) * 100;

  const weights = normalizeMatchWeights(config.reconciliationMatchWeights);
  const score = Math.round(amountScore * weights.amount + dateScore * weights.date + referenceScore * weights.reference);

  return { score, eligible: true, breakdown: { amountScore, dateScore, referenceScore } };
};

/** "Duplicate Transactions" — two statement lines with identical shape are almost certainly the same physical entry imported twice. */
export const isDuplicateStatementLine = (a, b) => a.direction === b.direction && a.currency === b.currency
  && Math.abs(a.amount - b.amount) < 0.01
  && new Date(a.transactionDate).toDateString() === new Date(b.transactionDate).toDateString()
  && (a.reference || "").trim().toLowerCase() === (b.reference || "").trim().toLowerCase();

const APPROVABLE_STATUSES = new Set(["Manual Review"]);
const COMPLETABLE_STATUSES = new Set(["Approved"]);
const REJECTABLE_STATUSES = new Set(["Manual Review", "Approved"]);
const REOPENABLE_STATUSES = new Set(["Approved", "Completed"]);
const ARCHIVABLE_STATUSES = new Set(["Completed", "Rejected"]);
const MATCHABLE_STATUSES = new Set(["Manual Review"]);

export const isReconciliationApprovable = (status) => APPROVABLE_STATUSES.has(status);
export const isReconciliationCompletable = (status) => COMPLETABLE_STATUSES.has(status);
export const isReconciliationRejectable = (status) => REJECTABLE_STATUSES.has(status);
export const isReconciliationReopenable = (status) => REOPENABLE_STATUSES.has(status);
export const isReconciliationArchivable = (status) => ARCHIVABLE_STATUSES.has(status);
export const isReconciliationMatchable = (status) => MATCHABLE_STATUSES.has(status);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class BankReconciliationService {
  static async _generateReconciliationNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "reconciliationNumber", year);
    return `${config.reconciliationNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * "Does the money in our ERP match the money shown by the bank?" — the
   * real ERP-side half of that question, computed from Part 13's own
   * immutable BankTransactionModel ledger (Credits minus Debits) up to and
   * including `asOfDate`, NOT the bank account's live `balances.current`.
   * A live balance would drift away from what "as of the statement date"
   * actually means the moment any newer, unrelated transaction posts —
   * summing the real ledger up to a point in time is the correct,
   * standard reconciliation semantic, and reuses Part 13's own "immutable
   * transaction history" as its authoritative source rather than trusting
   * a possibly-stale cached number.
   */
  static async _computeErpBalanceAsOf(bankAccountId, tenantId, asOfDate) {
    const endOfDay = new Date(asOfDate);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const [result] = await BankTransactionModel.aggregate([
      { $match: { tenantId, bankAccountId: new mongoose.Types.ObjectId(bankAccountId), createdAt: { $lte: endOfDay } } },
      { $group: { _id: null, credits: { $sum: { $cond: [{ $eq: ["$direction", "Credit"] }, "$amount", 0] } }, debits: { $sum: { $cond: [{ $eq: ["$direction", "Debit"] }, "$amount", 0] } } } }
    ]);
    return roundCurrency((result?.credits || 0) - (result?.debits || 0));
  }

  /** Recomputes matched/unmatched/exception counts and the live difference, and saves them. */
  static async _recalculateSummary(reconciliationId, tenantId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) return null;

    const [matchedCount, unmatchedCount, exceptionCount, erpBalance] = await Promise.all([
      BankStatementTransactionModel.countDocuments({ tenantId, reconciliationId, matchStatus: "Matched" }),
      BankStatementTransactionModel.countDocuments({ tenantId, reconciliationId, matchStatus: "Unmatched" }),
      BankReconciliationExceptionModel.countDocuments({ tenantId, reconciliationId, status: "Open" }),
      BankReconciliationService._computeErpBalanceAsOf(reconciliation.bankAccountId, tenantId, reconciliation.statementDate)
    ]);

    reconciliation.matchedCount = matchedCount;
    reconciliation.unmatchedCount = unmatchedCount;
    reconciliation.exceptionCount = exceptionCount;
    reconciliation.erpBalance = erpBalance;
    reconciliation.difference = roundCurrency(reconciliation.closingBalance - erpBalance);
    await reconciliation.save();
    return reconciliation;
  }

  /**
   * POST /api/v1/bank-reconciliation/import
   * Upload Statement -> Validate File -> Parse Transactions -> Create
   * Import Batch -> Auto Match -> Generate Exceptions -> Publish
   * StatementImported -> Return Success. All of it — including auto-match
   * and exception generation — happens synchronously within this one call,
   * exactly as the spec's own Business Workflow orders it; see
   * utils/financeConfig.js's own doc comment for why the session lands
   * directly on "Manual Review" rather than lingering in a transient
   * "Statement Imported"/"Auto Matching" status.
   */
  static async importStatement(data, fileBuffer, tenantId, userId) {
    const config = getFinanceConfig();
    const { bankAccountId, format, statementDate: callerStatementDate = null, openingBalance: callerOpening = null, closingBalance: callerClosing = null, currency: callerCurrency = null } = data;

    if (!bankAccountId || !format) throw new Error("bankAccountId and format are required.");
    if (!config.reconciliationImportFormats.includes(format)) throw new Error(`Invalid format "${format}".`);

    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).lean();
    if (!bankAccount) throw new Error("Bank account not found.");
    if (bankAccount.status === "Archived") throw new Error("Cannot reconcile an archived bank account.");

    const parser = getStatementParser(format);
    if (!parser) throw new Error(`Statement format "${format}" is not supported — no parser is implemented for it (services/reconciliationParsers/).`);
    if (!fileBuffer || fileBuffer.length === 0) throw new Error("A statement file is required.");
    if (fileBuffer.length > config.reconciliationImportMaxFileSizeBytes) {
      throw new Error(`Statement file exceeds the maximum allowed size of ${config.reconciliationImportMaxFileSizeBytes} bytes.`);
    }

    const parsed = await parser.parse(fileBuffer);

    const currency = parsed.currency || callerCurrency;
    if (!currency) throw new Error(`currency could not be determined from the ${format} file and was not supplied.`);
    if (currency !== bankAccount.currency) throw new Error(`Currency mismatch: statement is ${currency}, bank account is ${bankAccount.currency}.`);

    const statementDate = parsed.statementDate || (callerStatementDate ? new Date(callerStatementDate) : null);
    if (!statementDate || Number.isNaN(statementDate.getTime())) throw new Error(`statementDate could not be determined from the ${format} file and was not supplied.`);

    const openingBalance = parsed.openingBalance ?? callerOpening;
    const closingBalance = parsed.closingBalance ?? callerClosing;
    if (openingBalance === null || openingBalance === undefined) throw new Error(`openingBalance could not be determined from the ${format} file and was not supplied.`);
    if (closingBalance === null || closingBalance === undefined) throw new Error(`closingBalance could not be determined from the ${format} file and was not supplied.`);

    // "Duplicate Detection" — one reconciliation per account per statement date.
    const existing = await BankReconciliationModel.findOne({ tenantId, bankAccountId, statementDate }).lean();
    if (existing) throw new Error(`A reconciliation already exists for this bank account and statement date (${existing.reconciliationNumber}). Reject or archive it before re-importing.`);

    const erpBalance = await BankReconciliationService._computeErpBalanceAsOf(bankAccountId, tenantId, statementDate);
    const reconciliationNumber = await BankReconciliationService._generateReconciliationNumber(tenantId);

    let statementFile = { url: null, storageKey: null, storageProvider: null };
    try {
      const stored = await storeDocumentPdf({ tenantId, folder: "bank-statements", filename: `${reconciliationNumber}.${FILE_EXTENSIONS[format] || "dat"}`, buffer: fileBuffer });
      statementFile = { url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider };
    } catch (error) {
      // Archiving the raw file is real, but not load-bearing for the
      // reconciliation itself — a storage-backend problem shouldn't block
      // an otherwise-valid import (matches this codebase's general "don't
      // let a secondary concern fail the primary action" discipline).
      console.error("BankReconciliationService: failed to archive raw statement file:", error.message);
    }

    const reconciliation = await BankReconciliationModel.create({
      tenantId,
      reconciliationNumber,
      bankAccountId,
      statementDate,
      currency,
      sourceFormat: format,
      openingBalance: roundCurrency(openingBalance),
      closingBalance: roundCurrency(closingBalance),
      erpBalance,
      difference: roundCurrency(closingBalance - erpBalance),
      status: config.defaultReconciliationStatus,
      statementFile,
      timeline: [{ event: "StatementImported", description: `${format} statement imported (${parsed.transactions.length} transactions).`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await BankStatementTransactionModel.insertMany(parsed.transactions.map((t) => ({
      tenantId,
      reconciliationId: reconciliation._id,
      bankAccountId,
      externalTransactionId: t.externalTransactionId,
      transactionDate: t.transactionDate,
      valueDate: t.valueDate,
      direction: t.direction,
      amount: roundCurrency(t.amount),
      currency,
      reference: t.reference,
      rawLine: t.rawLine
    })));

    await BankReconciliationService._flagDuplicateStatementLines(reconciliation._id, tenantId, userId);
    await BankReconciliationService.runAutoMatch(reconciliation._id, tenantId, userId);

    await AuditLogModel.create({ action: "finance.reconciliation.import", module: "Finance", resource: "BankReconciliation", resourceId: reconciliation._id.toString(), userId: userId || null, tenantId, details: { reconciliationNumber, format, transactionCount: parsed.transactions.length } });
    publishEvent("StatementImported", { tenantId, reconciliationId: reconciliation._id.toString(), bankAccountId: bankAccountId.toString(), format, transactionCount: parsed.transactions.length, performedBy: userId || null });

    return BankReconciliationService.getReconciliationById(reconciliation._id, tenantId);
  }

  /** "Duplicate Transactions" exception — flags the second+ occurrence of an identical-looking imported line, real signal for a human to review, never auto-discarded. */
  static async _flagDuplicateStatementLines(reconciliationId, tenantId, userId) {
    const lines = await BankStatementTransactionModel.find({ tenantId, reconciliationId }).sort({ createdAt: 1 }).lean();
    const seen = [];
    for (const line of lines) {
      const duplicateOf = seen.find((s) => isDuplicateStatementLine(s, line));
      if (duplicateOf) {
        await BankReconciliationExceptionModel.create({
          tenantId, reconciliationId, bankAccountId: line.bankAccountId,
          exceptionType: "Duplicate", statementTransactionId: line._id,
          amount: line.amount, currency: line.currency,
          description: `Appears to duplicate statement line ${duplicateOf._id} (same amount/direction/date/reference).`,
          createdBy: userId || null,
          timeline: [{ event: "ExceptionCreated", description: "Possible duplicate statement line.", performedBy: userId || null }]
        });
        publishEvent("ExceptionCreated", { tenantId, reconciliationId: reconciliationId.toString(), exceptionType: "Duplicate", statementTransactionId: line._id.toString(), performedBy: userId || null });
      }
      seen.push(line);
    }
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/auto-match —
   * gap-fill (also called internally by importStatement, right after
   * import, per the spec's own Business Workflow). Greedy weighted
   * matching: each Unmatched statement line is scored against every
   * eligible, not-yet-consumed ERP candidate (same bank account, same
   * direction/currency, within the configured lookback window of the
   * statement date, and not already matched to any OTHER reconciliation's
   * statement line — overlapping monthly statements never double-claim the
   * same ERP transaction); the best score at/above the auto-match
   * threshold wins. Anything left unmatched after this becomes a real
   * `BankReconciliationExceptionModel` row, on both sides — a statement
   * line with no ERP counterpart ("MissingERPEntry") and an ERP
   * transaction with no statement counterpart ("MissingBankEntry").
   */
  static async runAutoMatch(reconciliationId, tenantId, userId) {
    const config = getFinanceConfig();
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId }).lean();
    if (!reconciliation) throw new Error("Reconciliation not found.");

    const lookbackStart = new Date(reconciliation.statementDate);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - config.reconciliationLookbackDays);
    const lookbackEnd = new Date(reconciliation.statementDate);
    lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + config.reconciliationLookbackDays);
    lookbackEnd.setUTCHours(23, 59, 59, 999);

    const [statementLines, erpCandidatesRaw, alreadyMatchedElsewhere] = await Promise.all([
      BankStatementTransactionModel.find({ tenantId, reconciliationId, matchStatus: "Unmatched" }).sort({ transactionDate: 1 }).lean(),
      BankTransactionModel.find({ tenantId, bankAccountId: reconciliation.bankAccountId, createdAt: { $gte: lookbackStart, $lte: lookbackEnd } }).lean(),
      BankStatementTransactionModel.find({ tenantId, bankAccountId: reconciliation.bankAccountId, matchStatus: "Matched", matchedBankTransactionId: { $ne: null } }).select("matchedBankTransactionId").lean()
    ]);

    const globallyConsumed = new Set(alreadyMatchedElsewhere.map((m) => m.matchedBankTransactionId.toString()));
    const erpCandidates = erpCandidatesRaw.filter((t) => !globallyConsumed.has(t._id.toString())).map((t) => ({ ...t, date: t.createdAt }));
    const consumedThisRun = new Set();

    for (const statementLine of statementLines) {
      let best = null;
      for (const erpTxn of erpCandidates) {
        if (consumedThisRun.has(erpTxn._id.toString())) continue;
        const { score, eligible } = computeMatchScore({ statementTxn: statementLine, erpTxn, config });
        if (eligible && score >= config.reconciliationAutoMatchThreshold && (!best || score > best.score)) {
          best = { erpTxn, score };
        }
      }

      if (best) {
        consumedThisRun.add(best.erpTxn._id.toString());
        await BankStatementTransactionModel.updateOne(
          { _id: statementLine._id, tenantId },
          { $set: { matchStatus: "Matched", matchedBankTransactionId: best.erpTxn._id, matchScore: best.score, matchMethod: "Auto", matchedBy: "system", matchedAt: new Date() } }
        );
        publishEvent("TransactionMatched", { tenantId, reconciliationId: reconciliationId.toString(), statementTransactionId: statementLine._id.toString(), bankTransactionId: best.erpTxn._id.toString(), matchScore: best.score, matchMethod: "Auto", performedBy: "system" });
      }
    }

    // Generate exceptions for whatever is still unresolved after matching.
    const unmatchedLines = await BankStatementTransactionModel.find({ tenantId, reconciliationId, matchStatus: "Unmatched" }).lean();
    for (const line of unmatchedLines) {
      const alreadyFlagged = await BankReconciliationExceptionModel.exists({ tenantId, reconciliationId, statementTransactionId: line._id, exceptionType: "MissingERPEntry" });
      if (alreadyFlagged) continue;
      await BankReconciliationExceptionModel.create({
        tenantId, reconciliationId, bankAccountId: reconciliation.bankAccountId,
        exceptionType: "MissingERPEntry", statementTransactionId: line._id,
        amount: line.amount, currency: line.currency,
        description: `Statement shows ${line.direction} of ${line.amount} ${line.currency} on ${new Date(line.transactionDate).toDateString()} with no matching ERP transaction.`,
        createdBy: userId || null,
        timeline: [{ event: "ExceptionCreated", description: "No matching ERP transaction found.", performedBy: userId || "system" }]
      });
      publishEvent("ExceptionCreated", { tenantId, reconciliationId: reconciliationId.toString(), exceptionType: "MissingERPEntry", statementTransactionId: line._id.toString(), performedBy: userId || "system" });
    }

    for (const erpTxn of erpCandidates) {
      if (consumedThisRun.has(erpTxn._id.toString())) continue;
      const alreadyFlagged = await BankReconciliationExceptionModel.exists({ tenantId, reconciliationId, bankTransactionId: erpTxn._id, exceptionType: "MissingBankEntry" });
      if (alreadyFlagged) continue;
      await BankReconciliationExceptionModel.create({
        tenantId, reconciliationId, bankAccountId: reconciliation.bankAccountId,
        exceptionType: "MissingBankEntry", bankTransactionId: erpTxn._id,
        amount: erpTxn.amount, currency: erpTxn.currency,
        description: `ERP shows ${erpTxn.direction} of ${erpTxn.amount} ${erpTxn.currency} (${erpTxn.transactionNumber}) with no matching statement line — possibly an outstanding cheque, pending deposit, or settlement delay.`,
        createdBy: userId || null,
        timeline: [{ event: "ExceptionCreated", description: "No matching statement line found.", performedBy: userId || "system" }]
      });
      publishEvent("ExceptionCreated", { tenantId, reconciliationId: reconciliationId.toString(), exceptionType: "MissingBankEntry", bankTransactionId: erpTxn._id.toString(), performedBy: userId || "system" });
    }

    return BankReconciliationService._recalculateSummary(reconciliationId, tenantId);
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/match
   * Validate Transactions -> Verify Amount -> Verify Date -> Create Match
   * -> Update Difference -> Audit -> Publish TransactionMatched. Direction
   * and currency mismatches are hard-blocked (nonsensical to match a debit
   * statement line to a credit ERP entry); amount/date differences are
   * NOT blocked — a human manually matching is precisely the override path
   * for cases auto-matching's tolerance windows couldn't resolve. The
   * computed score is still stored (informational, for audit) even though
   * `matchMethod` records this as a deliberate manual decision.
   */
  static async matchTransaction(reconciliationId, { statementTransactionId, erpTransactionId }, tenantId, userId, options = {}) {
    if (!statementTransactionId || !erpTransactionId) throw new Error("statementTransactionId and erpTransactionId are required.");

    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId }).lean();
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationMatchable(reconciliation.status)) throw new Error(`Reconciliation cannot be matched from status "${reconciliation.status}".`);

    const statementLine = await BankStatementTransactionModel.findOne({ _id: statementTransactionId, tenantId, reconciliationId });
    if (!statementLine) throw new Error("Statement transaction not found.");
    if (statementLine.matchStatus === "Matched") throw new Error("This statement transaction is already matched.");

    const erpTxn = await BankTransactionModel.findOne({ _id: erpTransactionId, tenantId, bankAccountId: reconciliation.bankAccountId }).lean();
    if (!erpTxn) throw new Error("ERP transaction not found for this bank account.");
    if (statementLine.direction !== erpTxn.direction) throw new Error("Cannot match transactions with different directions (Credit/Debit).");
    if (statementLine.currency !== erpTxn.currency) throw new Error("Cannot match transactions in different currencies.");

    const alreadyClaimed = await BankStatementTransactionModel.exists({ tenantId, matchedBankTransactionId: erpTransactionId, matchStatus: "Matched" });
    if (alreadyClaimed) throw new Error("This ERP transaction is already matched to another statement line.");

    const { score } = computeMatchScore({ statementTxn: statementLine, erpTxn: { ...erpTxn, date: erpTxn.createdAt }, config: getFinanceConfig() });
    const matchMethod = options.matchMethod || "Manual";

    statementLine.matchStatus = "Matched";
    statementLine.matchedBankTransactionId = erpTransactionId;
    statementLine.matchScore = score;
    statementLine.matchMethod = matchMethod;
    statementLine.matchedBy = userId || null;
    statementLine.matchedAt = new Date();
    await statementLine.save();

    // Auto-resolve any open exception this match now explains.
    await BankReconciliationExceptionModel.updateMany(
      { tenantId, reconciliationId, status: "Open", $or: [{ statementTransactionId }, { bankTransactionId: erpTransactionId }] },
      { $set: { status: "Resolved", resolutionAction: "ManuallyMatched", resolvedBy: userId || null, resolvedAt: new Date() } }
    );

    await AuditLogModel.create({ action: "finance.reconciliation.match", module: "Finance", resource: "BankReconciliation", resourceId: reconciliationId.toString(), userId: userId || null, tenantId, details: { statementTransactionId: statementTransactionId.toString(), erpTransactionId: erpTransactionId.toString(), matchMethod, score } });
    publishEvent("TransactionMatched", { tenantId, reconciliationId: reconciliationId.toString(), statementTransactionId: statementTransactionId.toString(), bankTransactionId: erpTransactionId.toString(), matchScore: score, matchMethod, performedBy: userId || null });

    await BankReconciliationService._recalculateSummary(reconciliationId, tenantId);
    return statementLine.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/unmatch —
   * gap-fill: `TransactionUnmatched` is a named domain event with no
   * endpoint contracted for it — corrects a wrong auto- or manual match.
   */
  static async unmatchTransaction(reconciliationId, { statementTransactionId }, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId }).lean();
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationMatchable(reconciliation.status)) throw new Error(`Reconciliation cannot be modified from status "${reconciliation.status}".`);

    const statementLine = await BankStatementTransactionModel.findOne({ _id: statementTransactionId, tenantId, reconciliationId });
    if (!statementLine) throw new Error("Statement transaction not found.");
    if (statementLine.matchStatus !== "Matched") throw new Error("This statement transaction is not currently matched.");

    const previousBankTransactionId = statementLine.matchedBankTransactionId;
    statementLine.matchStatus = "Unmatched";
    statementLine.matchedBankTransactionId = null;
    statementLine.matchScore = null;
    statementLine.matchMethod = null;
    statementLine.matchedBy = null;
    statementLine.matchedAt = null;
    await statementLine.save();

    await AuditLogModel.create({ action: "finance.reconciliation.unmatch", module: "Finance", resource: "BankReconciliation", resourceId: reconciliationId.toString(), userId: userId || null, tenantId, details: { statementTransactionId: statementTransactionId.toString(), previousBankTransactionId: previousBankTransactionId?.toString() || null } });
    publishEvent("TransactionUnmatched", { tenantId, reconciliationId: reconciliationId.toString(), statementTransactionId: statementTransactionId.toString(), performedBy: userId || null });

    await BankReconciliationService._recalculateSummary(reconciliationId, tenantId);
    return statementLine.toJSON();
  }

  /**
   * GET /api/v1/bank-reconciliation/{reconciliationId}/exceptions
   */
  static async listExceptions(reconciliationId, query, tenantId) {
    const filter = { tenantId, reconciliationId };
    if (query.status) filter.status = query.status;
    if (query.exceptionType) filter.exceptionType = query.exceptionType;
    return BankReconciliationExceptionModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  /**
   * POST /api/v1/bank-reconciliation/exceptions/{exceptionId}/resolve —
   * gap-fill (real workflow continuation for the named `ExceptionCreated`
   * event; no `ExceptionResolved` event is named, so none is invented).
   */
  static async resolveException(exceptionId, data, tenantId, userId) {
    const { resolutionAction, notes = null } = data;
    if (!resolutionAction) throw new Error("resolutionAction is required.");

    const exception = await BankReconciliationExceptionModel.findOne({ _id: exceptionId, tenantId });
    if (!exception) throw new Error("Exception not found.");
    if (exception.status !== "Open") throw new Error(`Exception cannot be resolved from status "${exception.status}".`);

    exception.status = resolutionAction === "Ignored" ? "Ignored" : "Resolved";
    exception.resolutionAction = resolutionAction;
    exception.resolutionNotes = notes;
    exception.resolvedBy = userId || null;
    exception.resolvedAt = new Date();
    exception.timeline.push({ event: "ExceptionResolved", description: notes || resolutionAction, performedBy: userId || null });
    await exception.save();

    await AuditLogModel.create({ action: "finance.reconciliation.resolve_exception", module: "Finance", resource: "BankReconciliationException", resourceId: exception._id.toString(), userId: userId || null, tenantId, details: { resolutionAction, notes } });

    await BankReconciliationService._recalculateSummary(exception.reconciliationId, tenantId);
    return exception.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/adjustments —
   * gap-fill for the named `BankAdjustmentCreated` event. "Bank Charges,
   * Interest Income, FX Gain/Loss, Correction Entries — Automatic Journal
   * Generation" reuses Part 13's own `BankAccountService.manualAdjustment`
   * entirely rather than reimplementing balance mutation/journal posting a
   * second time — this method's only real job is linking that real
   * BankTransactionModel/journal back to this reconciliation session (and,
   * optionally, resolving the exception it explains).
   */
  static async createAdjustment(reconciliationId, data, tenantId, userId) {
    const { direction, amount, adjustmentType, reason, exceptionId = null } = data;
    if (!["BankCharge", "InterestIncome", "FxGainLoss", "Correction"].includes(adjustmentType)) {
      throw new Error('adjustmentType must be one of "BankCharge", "InterestIncome", "FxGainLoss", "Correction".');
    }

    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!["Manual Review", "Approved"].includes(reconciliation.status)) {
      throw new Error(`Adjustments cannot be created for a reconciliation in status "${reconciliation.status}".`);
    }

    const { transaction, journalId } = await BankAccountService.manualAdjustment(reconciliation.bankAccountId, { direction, amount, reason }, tenantId, userId);

    reconciliation.adjustments.push({
      bankTransactionId: transaction._id,
      journalId,
      direction,
      amount: roundCurrency(amount),
      adjustmentType,
      reason,
      exceptionId,
      createdBy: userId || null
    });
    reconciliation.timeline.push({ event: "BankAdjustmentCreated", description: `${adjustmentType}: ${direction} of ${amount} ${reconciliation.currency} — ${reason}.`, performedBy: userId || null });
    await reconciliation.save();

    if (exceptionId) {
      await BankReconciliationExceptionModel.updateOne(
        { _id: exceptionId, tenantId, status: "Open" },
        { $set: { status: "Resolved", resolutionAction: "AdjustmentCreated", resolutionNotes: reason, resolvedBy: userId || null, resolvedAt: new Date() } }
      );
    }

    await AuditLogModel.create({ action: "finance.reconciliation.create_adjustment", module: "Finance", resource: "BankReconciliation", resourceId: reconciliationId.toString(), userId: userId || null, tenantId, details: { adjustmentType, direction, amount: roundCurrency(amount), journalId: journalId ? journalId.toString() : null } });
    publishEvent("BankAdjustmentCreated", { tenantId, reconciliationId: reconciliationId.toString(), bankAccountId: reconciliation.bankAccountId.toString(), adjustmentType, direction, amount: roundCurrency(amount), performedBy: userId || null });

    return BankReconciliationService._recalculateSummary(reconciliationId, tenantId);
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/approve
   */
  static async approveReconciliation(reconciliationId, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationApprovable(reconciliation.status)) throw new Error(`Reconciliation cannot be approved from status "${reconciliation.status}".`);

    reconciliation.status = "Approved";
    reconciliation.approvedBy = userId || null;
    reconciliation.approvedAt = new Date();
    reconciliation.updatedBy = userId || null;
    reconciliation.timeline.push({ event: "ReconciliationApproved", description: "Reconciliation approved.", performedBy: userId || null });
    await reconciliation.save();

    await AuditLogModel.create({ action: "finance.reconciliation.approve", module: "Finance", resource: "BankReconciliation", resourceId: reconciliation._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("ReconciliationApproved", { tenantId, reconciliationId: reconciliation._id.toString(), performedBy: userId || null });

    return reconciliation.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/complete — real
   * gate: every exception must be Resolved/Ignored first. "Approved" only
   * means a reviewer confirmed the matching results look right; "Completed"
   * means every difference has genuinely been identified, explained, and
   * resolved — the two-step gate this whole module exists to enforce.
   */
  static async completeReconciliation(reconciliationId, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationCompletable(reconciliation.status)) throw new Error(`Reconciliation cannot be completed from status "${reconciliation.status}".`);

    const openExceptions = await BankReconciliationExceptionModel.countDocuments({ tenantId, reconciliationId, status: "Open" });
    if (openExceptions > 0) throw new Error(`Cannot complete: ${openExceptions} exception(s) are still Open. Resolve or ignore them first.`);

    reconciliation.status = "Completed";
    reconciliation.completedBy = userId || null;
    reconciliation.completedAt = new Date();
    reconciliation.updatedBy = userId || null;
    reconciliation.timeline.push({ event: "ReconciliationCompleted", description: `Completed with a final difference of ${reconciliation.difference} ${reconciliation.currency}.`, performedBy: userId || null });
    await reconciliation.save();

    await AuditLogModel.create({ action: "finance.reconciliation.complete", module: "Finance", resource: "BankReconciliation", resourceId: reconciliation._id.toString(), userId: userId || null, tenantId, details: { finalDifference: reconciliation.difference } });
    publishEvent("ReconciliationCompleted", { tenantId, reconciliationId: reconciliation._id.toString(), finalDifference: reconciliation.difference, performedBy: userId || null });

    return reconciliation.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/reject — no
   * domain event is named for this transition; none invented.
   */
  static async rejectReconciliation(reconciliationId, data, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationRejectable(reconciliation.status)) throw new Error(`Reconciliation cannot be rejected from status "${reconciliation.status}".`);

    reconciliation.status = "Rejected";
    reconciliation.rejectedBy = userId || null;
    reconciliation.rejectedAt = new Date();
    reconciliation.rejectionReason = data?.reason || null;
    reconciliation.updatedBy = userId || null;
    reconciliation.timeline.push({ event: "ReconciliationRejected", description: data?.reason || "Reconciliation rejected.", performedBy: userId || null });
    await reconciliation.save();

    await AuditLogModel.create({ action: "finance.reconciliation.reject", module: "Finance", resource: "BankReconciliation", resourceId: reconciliation._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return reconciliation.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/reopen
   */
  static async reopenReconciliation(reconciliationId, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationReopenable(reconciliation.status)) throw new Error(`Reconciliation cannot be reopened from status "${reconciliation.status}".`);

    reconciliation.status = "Manual Review";
    reconciliation.approvedBy = null;
    reconciliation.approvedAt = null;
    reconciliation.completedBy = null;
    reconciliation.completedAt = null;
    reconciliation.updatedBy = userId || null;
    reconciliation.timeline.push({ event: "ReconciliationReopened", description: "Reconciliation reopened for further review.", performedBy: userId || null });
    await reconciliation.save();

    await AuditLogModel.create({ action: "finance.reconciliation.reopen", module: "Finance", resource: "BankReconciliation", resourceId: reconciliation._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("ReconciliationReopened", { tenantId, reconciliationId: reconciliation._id.toString(), performedBy: userId || null });

    return reconciliation.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/archive —
   * gap-fill, no domain event named.
   */
  static async archiveReconciliation(reconciliationId, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId });
    if (!reconciliation) throw new Error("Reconciliation not found.");
    if (!isReconciliationArchivable(reconciliation.status)) throw new Error(`Reconciliation cannot be archived from status "${reconciliation.status}".`);

    reconciliation.status = "Archived";
    reconciliation.archivedBy = userId || null;
    reconciliation.archivedAt = new Date();
    reconciliation.updatedBy = userId || null;
    reconciliation.timeline.push({ event: "ReconciliationArchived", description: "Reconciliation archived.", performedBy: userId || null });
    await reconciliation.save();

    await AuditLogModel.create({ action: "finance.reconciliation.archive", module: "Finance", resource: "BankReconciliation", resourceId: reconciliation._id.toString(), userId: userId || null, tenantId, details: {} });

    return reconciliation.toJSON();
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/ai-suggest —
   * "AI Matching... Suggest Likely Match... AI suggestions require user
   * approval." A real LLM call routed through the existing, already-wired
   * `AIModelRouterService` (the same real Anthropic/OpenAI/... infra
   * `AIOrchestrationService` already uses) — never a fabricated response.
   * Returns suggestions only; nothing is applied until
   * `acceptAiSuggestion` is called explicitly, which re-validates
   * everything through the normal `matchTransaction` path.
   */
  static async suggestAiMatches(reconciliationId, tenantId, userId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId }).lean();
    if (!reconciliation) throw new Error("Reconciliation not found.");

    const config = getFinanceConfig();
    const lookbackStart = new Date(reconciliation.statementDate);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - config.reconciliationLookbackDays);
    const lookbackEnd = new Date(reconciliation.statementDate);
    lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + config.reconciliationLookbackDays);
    lookbackEnd.setUTCHours(23, 59, 59, 999);

    const [statementLines, erpCandidates] = await Promise.all([
      BankStatementTransactionModel.find({ tenantId, reconciliationId, matchStatus: "Unmatched" }).limit(20).lean(),
      BankTransactionModel.find({ tenantId, bankAccountId: reconciliation.bankAccountId, createdAt: { $gte: lookbackStart, $lte: lookbackEnd } }).limit(40).lean()
    ]);

    if (statementLines.length === 0 || erpCandidates.length === 0) {
      return { aiAvailable: true, suggestions: [], message: "Nothing unmatched to suggest against." };
    }

    const systemPrompt = "You are a bank reconciliation assistant. Given a list of unmatched bank statement lines and a list of candidate ERP transactions, suggest which pairs are LIKELY the same real-world transaction. Only suggest pairs you are reasonably confident about. Respond with ONLY JSON, no prose, in this exact shape: {\"suggestions\":[{\"statementTransactionId\":\"...\",\"erpTransactionId\":\"...\",\"confidence\":0-100,\"reasoning\":\"...\"}]}. These suggestions will NOT be applied automatically — a human reviews and approves each one.";
    const userPrompt = `Statement lines (unmatched):\n${JSON.stringify(statementLines.map((s) => ({ id: s._id.toString(), direction: s.direction, amount: s.amount, date: s.transactionDate, reference: s.reference })))}\n\nCandidate ERP transactions:\n${JSON.stringify(erpCandidates.map((e) => ({ id: e._id.toString(), direction: e.direction, amount: e.amount, date: e.createdAt, description: e.description })))}`;

    let llmResult;
    try {
      llmResult = await AIModelRouterService.route({ tenantId, category: "reasoning", messages: [{ role: "user", content: userPrompt }], tools: [], systemPrompt });
    } catch (error) {
      // Honest failure — same discipline as every other AI call in this
      // codebase (AIModelRouterService.route itself never fabricates a
      // response when no provider is reachable).
      return { aiAvailable: false, suggestions: [], message: error.message };
    }

    let suggestions = [];
    try {
      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(jsonText);
      suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    } catch {
      return { aiAvailable: true, suggestions: [], message: "The AI did not return a valid suggestion list." };
    }

    // Never trust the model's ids blindly — only suggestions naming a real
    // pair actually present in the candidates supplied survive.
    const statementIds = new Set(statementLines.map((s) => s._id.toString()));
    const erpIds = new Set(erpCandidates.map((e) => e._id.toString()));
    const validSuggestions = suggestions.filter((s) => statementIds.has(s.statementTransactionId) && erpIds.has(s.erpTransactionId));

    return { aiAvailable: true, suggestions: validSuggestions, provider: llmResult.provider, model: llmResult.model };
  }

  /**
   * POST /api/v1/bank-reconciliation/{reconciliationId}/ai-accept — the
   * real "user approval" step "AI Matching" requires; thin wrapper over
   * `matchTransaction` tagging `matchMethod: "AI-Suggested"` so the audit
   * trail shows exactly how this pairing was decided.
   */
  static async acceptAiSuggestion(reconciliationId, data, tenantId, userId) {
    return BankReconciliationService.matchTransaction(reconciliationId, data, tenantId, userId, { matchMethod: "AI-Suggested" });
  }

  /**
   * GET /api/v1/bank-reconciliation
   */
  static async listReconciliations(query, tenantId) {
    const config = getFinanceConfig();
    const { bankAccount, status, currency } = query;
    const filter = { tenantId };
    if (bankAccount) filter.bankAccountId = bankAccount;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (query.statementDate) filter.statementDate = new Date(query.statementDate);

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { statementDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      BankReconciliationModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      BankReconciliationModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/bank-reconciliation/{reconciliationId}
   */
  static async getReconciliationById(reconciliationId, tenantId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId }).lean();
    if (!reconciliation) throw new Error("Reconciliation not found.");

    const [openExceptions, auditSummary] = await Promise.all([
      BankReconciliationExceptionModel.find({ tenantId, reconciliationId, status: "Open" }).lean(),
      AuditLogModel.find({ tenantId, resource: "BankReconciliation", resourceId: reconciliation._id.toString() }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    return { ...reconciliation, openExceptions, auditSummary };
  }

  /**
   * GET /api/v1/bank-reconciliation/{reconciliationId}/transactions
   */
  static async listStatementTransactions(reconciliationId, query, tenantId) {
    const filter = { tenantId, reconciliationId };
    if (query.matchStatus) filter.matchStatus = query.matchStatus;
    if (query.direction) filter.direction = query.direction;
    return BankStatementTransactionModel.find(filter).sort({ transactionDate: 1 }).lean();
  }

  /**
   * GET /api/v1/bank-reconciliation/{reconciliationId}/report —
   * "Statement Summary, Matched Transactions, Unmatched Transactions,
   * Adjustments, Exceptions, Final Difference, Audit History."
   */
  static async generateReport(reconciliationId, tenantId) {
    const reconciliation = await BankReconciliationModel.findOne({ _id: reconciliationId, tenantId }).lean();
    if (!reconciliation) throw new Error("Reconciliation not found.");

    const [matched, unmatched, exceptions, auditHistory] = await Promise.all([
      BankStatementTransactionModel.find({ tenantId, reconciliationId, matchStatus: "Matched" }).sort({ transactionDate: 1 }).lean(),
      BankStatementTransactionModel.find({ tenantId, reconciliationId, matchStatus: "Unmatched" }).sort({ transactionDate: 1 }).lean(),
      BankReconciliationExceptionModel.find({ tenantId, reconciliationId }).sort({ createdAt: 1 }).lean(),
      AuditLogModel.find({ tenantId, resource: "BankReconciliation", resourceId: reconciliationId.toString() }).sort({ createdAt: 1 }).lean()
    ]);

    return {
      summary: {
        reconciliationNumber: reconciliation.reconciliationNumber,
        bankAccountId: reconciliation.bankAccountId,
        statementDate: reconciliation.statementDate,
        currency: reconciliation.currency,
        openingBalance: reconciliation.openingBalance,
        closingBalance: reconciliation.closingBalance,
        erpBalance: reconciliation.erpBalance,
        difference: reconciliation.difference,
        status: reconciliation.status
      },
      matchedTransactions: matched,
      unmatchedTransactions: unmatched,
      adjustments: reconciliation.adjustments,
      exceptions,
      finalDifference: reconciliation.difference,
      auditHistory
    };
  }

  /** "Export supported." Real CSV export — no PDF export this pass (see docs/05-api/07-finance-api.md Part 14 Deferred). */
  static async exportReportCsv(reconciliationId, tenantId) {
    const report = await BankReconciliationService.generateReport(reconciliationId, tenantId);
    const rows = [["Section", "Date", "Direction", "Amount", "Currency", "Reference/Description", "Status"]];

    for (const t of report.matchedTransactions) rows.push(["Matched", new Date(t.transactionDate).toISOString().slice(0, 10), t.direction, t.amount, t.currency, t.reference || "", t.matchMethod || ""]);
    for (const t of report.unmatchedTransactions) rows.push(["Unmatched", new Date(t.transactionDate).toISOString().slice(0, 10), t.direction, t.amount, t.currency, t.reference || "", ""]);
    for (const a of report.adjustments) rows.push(["Adjustment", new Date(a.createdAt).toISOString().slice(0, 10), a.direction, a.amount, report.summary.currency, `${a.adjustmentType}: ${a.reason}`, ""]);
    for (const e of report.exceptions) rows.push(["Exception", new Date(e.createdAt).toISOString().slice(0, 10), "", e.amount || "", e.currency || "", `${e.exceptionType}: ${e.description || ""}`, e.status]);

    const escapeCsvCell = (cell) => {
      const str = String(cell ?? "");
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");

    return { filename: `${report.summary.reconciliationNumber}.csv`, csv };
  }
}

export default BankReconciliationService;
