import mongoose from "mongoose";
import JournalModel from "../models/JournalModel.js";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import LedgerService from "./LedgerService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class JournalService {
  static async _generateJournalNumber(tenantId, financialYear) {
    const config = getFinanceConfig();
    const seq = await FinanceSequenceModel.getNext(tenantId, "journalNumber", financialYear);
    return `${config.journalNumberPrefix}-${financialYear}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * Resolves each raw line's account reference to a real, postable account.
   * Accepts `accountId` (ObjectId, preferred) or `accountCode`/`account`
   * (string) — the latter resolved by exact accountCode match first, then a
   * case-insensitive exact name match as a last resort, for compatibility
   * with the spec's own request example (`"account": "Office Rent Expense"`).
   * "Validate Accounts": must exist in-tenant, be Active, and allow posting.
   */
  static async _resolveAccountsForLines(rawLines, tenantId) {
    if (!Array.isArray(rawLines) || rawLines.length < 2) {
      throw new Error("A journal requires at least two lines.");
    }

    const resolved = [];
    for (const raw of rawLines) {
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

      resolved.push({
        accountId: account._id,
        accountCode: account.accountCode,
        debit: roundCurrency(raw.debit || 0),
        credit: roundCurrency(raw.credit || 0),
        description: raw.description || null
      });
    }

    return resolved;
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

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getJournalById(journalId, tenantId) {
    const journal = await JournalModel.findOne({ _id: journalId, tenantId }).lean();
    if (!journal) throw new Error("Journal not found.");
    return journal;
  }

  /**
   * POST /api/v1/journals
   * Validate Financial Period -> Validate Accounts -> Validate Debit/Credit
   * Balance -> Create Journal -> Generate Audit -> Publish JournalCreated.
   */
  static async createJournal(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { journalType = config.defaultJournalType, postingDate, description = null, referenceNumber = null, currency, lines: rawLines, remarks = null, attachments = [] } = data;

    if (!postingDate) throw new Error("postingDate is required.");
    const postingDateObj = new Date(postingDate);

    await FinancialPeriodService.assertPeriodOpen(tenantId, postingDateObj);

    const lines = await JournalService._resolveAccountsForLines(rawLines, tenantId);
    const { debitTotal, creditTotal } = validateDoubleEntryLines(lines);

    const financialYear = `${postingDateObj.getUTCFullYear()}`;
    const journalNumber = await JournalService._generateJournalNumber(tenantId, financialYear);

    const journal = await JournalModel.create({
      tenantId,
      journalNumber,
      journalType,
      status: config.defaultJournalStatus,
      postingDate: postingDateObj,
      financialYear,
      description,
      referenceNumber,
      currency: currency || config.defaultCurrency,
      lines,
      debitTotal,
      creditTotal,
      remarks,
      attachments,
      createdBy: userId || null,
      updatedBy: userId || null
    });

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
      const lines = await JournalService._resolveAccountsForLines(rawLines, tenantId);
      const { debitTotal, creditTotal } = validateDoubleEntryLines(lines);
      changedFields.lines = lines;
      changedFields.debitTotal = debitTotal;
      changedFields.creditTotal = creditTotal;
    }

    changedFields.updatedBy = userId || null;
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

    await AuditLogModel.create({ action: "finance.journal.cancel", module: "Finance", resource: "Journal", resourceId: journal._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("JournalCancelled", { tenantId, journalId: journal._id.toString(), performedBy: userId || null });

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
}

export default JournalService;
