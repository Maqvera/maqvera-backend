import CashLocationModel from "../models/CashLocationModel.js";
import CashTransactionModel from "../models/CashTransactionModel.js";
import CashTransferModel from "../models/CashTransferModel.js";
import CashCountModel from "../models/CashCountModel.js";
import PettyCashAdvanceModel from "../models/PettyCashAdvanceModel.js";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import UserModel from "../models/Usermodel.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/cashManagementService.test.js).
// ---------------------------------------------------------------------------

/** "Variance Report" — None only when |variance| is at/under the configured tolerance. */
export const classifyVariance = (variance, tolerance = 0) => {
  if (Math.abs(variance) <= Math.max(tolerance, 0)) return "None";
  return variance > 0 ? "Overage" : "Shortage";
};

export const isCashLocationCloseable = (status) => status === "Opened";
export const isCashLocationArchivable = (status) => status === "Closed";

const TRANSFER_APPROVABLE_STATUSES = new Set(["Pending Approval", "Approved"]);
const TRANSFER_REJECTABLE_STATUSES = new Set(["Pending Approval", "Approved"]);
const TRANSFER_CANCELLABLE_STATUSES = new Set(["Pending Approval", "Approved"]);

export const isCashTransferApprovable = (status) => TRANSFER_APPROVABLE_STATUSES.has(status);
export const isCashTransferRejectable = (status) => TRANSFER_REJECTABLE_STATUSES.has(status);
export const isCashTransferCancellable = (status) => TRANSFER_CANCELLABLE_STATUSES.has(status);

/** "Dual Control... Dual Authorization." How many DIFFERENT users must approve before a transfer executes. */
export const requiredApprovalCount = (requiresDualAuthorization) => (requiresDualAuthorization ? 2 : 1);

/** True once enough DISTINCT users (never the same user counted twice) have approved. */
export const hasEnoughApprovals = (approvals, requiredCount) => new Set((approvals || []).map((a) => a.approvedBy)).size >= requiredCount;

export const isPettyCashAdvanceSettleable = (status) => status === "Issued" || status === "Partially Settled";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CashManagementService {
  static async _generateCode(tenantId, scope, prefix) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, scope, year);
    return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * POST /api/v1/cash-locations
   * Validate Currency -> Approval Workflow -> Create Cash Location -> Audit
   * -> Publish CashLocationCreated. "Validate Branch"/"Branch Match" are
   * dropped entirely (see utils/financeConfig.js's own doc comment) —
   * "Validate Organization" collapses into the tenant check every
   * controller already performs via getAccessScope, same as Bank Account
   * (Part 13). A location starts directly `Opened` — "Location Created"
   * and "Opened" are the same real moment, not two separate steps (same
   * collapse already applied to Bank Account's "Created").
   */
  static async createCashLocation(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, type, currency, glAccountCode = null, responsibleEmployeeId = null, dualAuthorizationRequired = false, targetFloatAmount = null } = data;

    if (!name || !type || !currency) throw new Error("name, type, and currency are required.");
    if (!config.cashLocationTypes.includes(type)) throw new Error(`Invalid type "${type}".`);
    if (!config.supportedCurrencies.includes(currency)) throw new Error(`Unsupported currency "${currency}".`);

    const existing = await CashLocationModel.findOne({ tenantId, name }).lean();
    if (existing) throw new Error(`A cash location named "${name}" already exists.`);

    if (glAccountCode) {
      const glAccount = await ChartOfAccountModel.findOne({ tenantId, accountCode: glAccountCode }).lean();
      if (!glAccount) throw new Error(`Chart of Accounts entry "${glAccountCode}" not found.`);
    }

    let responsibleEmployeeName = null;
    if (responsibleEmployeeId) {
      const employee = await UserModel.findById(responsibleEmployeeId).lean();
      if (!employee) throw new Error("Responsible employee not found.");
      responsibleEmployeeName = employee.username;
    }

    const cashLocationCode = await CashManagementService._generateCode(tenantId, "cashLocationCode", config.cashLocationCodePrefix);

    const cashLocation = await CashLocationModel.create({
      tenantId,
      cashLocationCode,
      name,
      type,
      currency,
      glAccountCode,
      responsibleEmployeeId,
      responsibleEmployeeName,
      dualAuthorizationRequired,
      targetFloatAmount,
      balance: 0,
      status: config.defaultCashLocationStatus,
      openedBy: userId || null,
      openedAt: new Date(),
      timeline: [{ event: "CashLocationCreated", description: `Cash location ${cashLocationCode} (${name}) created.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.cash.create_location", module: "Finance", resource: "CashLocation", resourceId: cashLocation._id.toString(), userId: userId || null, tenantId, details: { cashLocationCode, type, currency } });
    publishEvent("CashLocationCreated", { tenantId, cashLocationId: cashLocation._id.toString(), cashLocationCode, type, currency, performedBy: userId || null });

    return cashLocation.toJSON();
  }

  /**
   * GET /api/v1/cash-locations
   */
  static async listCashLocations(query, tenantId) {
    const config = getFinanceConfig();
    const { type, status, currency } = query;
    const filter = { tenantId };
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { createdAt: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      CashLocationModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      CashLocationModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/cash-locations/{cashLocationId}
   */
  static async getCashLocationById(cashLocationId, tenantId) {
    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId }).lean();
    if (!cashLocation) throw new Error("Cash location not found.");

    const [recentTransactions, auditSummary] = await Promise.all([
      CashTransactionModel.find({ tenantId, cashLocationId }).sort({ createdAt: -1 }).limit(20).lean(),
      AuditLogModel.find({ tenantId, resource: "CashLocation", resourceId: cashLocation._id.toString() }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    return { ...cashLocation, recentTransactions, auditSummary };
  }

  /**
   * PATCH /api/v1/cash-locations/{cashLocationId} — gap-fill, non-financial
   * metadata only (mirrors BankAccountService.updateBankAccount).
   */
  static async updateCashLocation(cashLocationId, data, tenantId, userId) {
    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId });
    if (!cashLocation) throw new Error("Cash location not found.");

    const { name, glAccountCode, responsibleEmployeeId, dualAuthorizationRequired, targetFloatAmount } = data;
    if (name !== undefined && name !== cashLocation.name) {
      const existing = await CashLocationModel.findOne({ tenantId, name, _id: { $ne: cashLocationId } }).lean();
      if (existing) throw new Error(`A cash location named "${name}" already exists.`);
      cashLocation.name = name;
    }
    if (glAccountCode !== undefined) {
      if (glAccountCode) {
        const glAccount = await ChartOfAccountModel.findOne({ tenantId, accountCode: glAccountCode }).lean();
        if (!glAccount) throw new Error(`Chart of Accounts entry "${glAccountCode}" not found.`);
      }
      cashLocation.glAccountCode = glAccountCode;
    }
    if (responsibleEmployeeId !== undefined) {
      if (responsibleEmployeeId) {
        const employee = await UserModel.findById(responsibleEmployeeId).lean();
        if (!employee) throw new Error("Responsible employee not found.");
        cashLocation.responsibleEmployeeId = responsibleEmployeeId;
        cashLocation.responsibleEmployeeName = employee.username;
      } else {
        cashLocation.responsibleEmployeeId = null;
        cashLocation.responsibleEmployeeName = null;
      }
    }
    if (dualAuthorizationRequired !== undefined) cashLocation.dualAuthorizationRequired = dualAuthorizationRequired;
    if (targetFloatAmount !== undefined) cashLocation.targetFloatAmount = targetFloatAmount;

    cashLocation.updatedBy = userId || null;
    cashLocation.timeline.push({ event: "CashLocationUpdated", description: "Cash location details updated.", performedBy: userId || null });
    await cashLocation.save();

    await AuditLogModel.create({ action: "finance.cash.update_location", module: "Finance", resource: "CashLocation", resourceId: cashLocation._id.toString(), userId: userId || null, tenantId, details: {} });

    return cashLocation.toJSON();
  }

  /**
   * POST /api/v1/cash-locations/{cashLocationId}/close
   */
  static async closeCashLocation(cashLocationId, data, tenantId, userId) {
    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId });
    if (!cashLocation) throw new Error("Cash location not found.");
    if (!isCashLocationCloseable(cashLocation.status)) throw new Error(`Cash location cannot be closed from status "${cashLocation.status}".`);
    if (cashLocation.balance !== 0) {
      throw new Error(`Cash location has a non-zero balance (${cashLocation.balance} ${cashLocation.currency}) and cannot be closed until it is transferred out or settled to zero.`);
    }

    cashLocation.status = "Closed";
    cashLocation.closedBy = userId || null;
    cashLocation.closedAt = new Date();
    cashLocation.closedReason = data?.reason || null;
    cashLocation.updatedBy = userId || null;
    cashLocation.timeline.push({ event: "CashLocationClosed", description: data?.reason || "Cash location closed.", performedBy: userId || null });
    await cashLocation.save();

    await AuditLogModel.create({ action: "finance.cash.close_location", module: "Finance", resource: "CashLocation", resourceId: cashLocation._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("CashLocationClosed", { tenantId, cashLocationId: cashLocation._id.toString(), performedBy: userId || null });

    return cashLocation.toJSON();
  }

  /**
   * POST /api/v1/cash-locations/{cashLocationId}/archive — gap-fill, no
   * domain event named.
   */
  static async archiveCashLocation(cashLocationId, tenantId, userId) {
    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId });
    if (!cashLocation) throw new Error("Cash location not found.");
    if (!isCashLocationArchivable(cashLocation.status)) throw new Error(`Cash location cannot be archived from status "${cashLocation.status}".`);

    cashLocation.status = "Archived";
    cashLocation.archivedBy = userId || null;
    cashLocation.archivedAt = new Date();
    cashLocation.updatedBy = userId || null;
    cashLocation.timeline.push({ event: "CashLocationArchived", description: "Cash location archived.", performedBy: userId || null });
    await cashLocation.save();

    await AuditLogModel.create({ action: "finance.cash.archive_location", module: "Finance", resource: "CashLocation", resourceId: cashLocation._id.toString(), userId: userId || null, tenantId, details: {} });

    return cashLocation.toJSON();
  }

  /**
   * Internal primitive — every real cash movement in this module goes
   * through this (mirrors BankAccountService.applyTransaction). Never
   * exposed directly as its own endpoint.
   */
  static async applyCashTransaction(cashLocationId, tenantId, { direction, amount, currency, type, sourceType = null, sourceId = null, description = null, performedBy = null }) {
    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId });
    if (!cashLocation) throw new Error("Cash location not found.");
    if (cashLocation.status !== "Opened") throw new Error(`Cash location is not transactable in status "${cashLocation.status}".`);
    if (currency && cashLocation.currency !== currency) throw new Error(`Currency mismatch: transaction is ${currency}, cash location is ${cashLocation.currency}.`);

    const roundedAmount = roundCurrency(amount);
    if (!(roundedAmount > 0)) throw new Error("Transaction amount must be greater than zero.");
    if (direction === "Debit" && roundedAmount > cashLocation.balance) {
      throw new Error(`Insufficient cash: requested ${roundedAmount} ${cashLocation.currency}, available ${cashLocation.balance}.`);
    }

    cashLocation.balance = roundCurrency(direction === "Credit" ? cashLocation.balance + roundedAmount : cashLocation.balance - roundedAmount);
    cashLocation.timeline.push({ event: "CashBalanceUpdated", description: `${direction} of ${roundedAmount} ${cashLocation.currency} (${type}).`, performedBy: performedBy || null });
    await cashLocation.save();

    const transactionNumber = await CashManagementService._generateCode(tenantId, "cashTransactionNumber", "CTX");
    const transaction = await CashTransactionModel.create({
      tenantId, cashLocationId: cashLocation._id, transactionNumber, direction, amount: roundedAmount,
      currency: cashLocation.currency, balanceAfter: cashLocation.balance, type, sourceType, sourceId, description, performedBy
    });

    return { cashLocation: cashLocation.toJSON(), transaction: transaction.toJSON() };
  }

  /**
   * GET /api/v1/cash-locations/{cashLocationId}/transactions
   */
  static async listCashLocationTransactions(cashLocationId, query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId, cashLocationId };
    if (query.direction) filter.direction = query.direction;
    if (query.type) filter.type = query.type;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      CashTransactionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      CashTransactionModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * POST /api/v1/cash-transfers
   * Validate Source -> Validate Destination -> Validate Available Cash ->
   * Approval Workflow -> Generate Journal -> Update Cash Balances -> Update
   * Ledger -> Audit -> Publish CashTransferred. Also the real mechanism
   * behind "Safe & Vault... Cash Deposit, Cash Withdrawal" — a deposit
   * into a Safe/Vault-typed location, or a withdrawal from one, is simply
   * a transfer where one side is that location.
   */
  static async createCashTransfer(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { fromLocationId, toLocationId, amount, reason = null } = data;

    if (!fromLocationId || !toLocationId || !amount) throw new Error("fromLocationId, toLocationId, and amount are required.");
    if (fromLocationId === toLocationId) throw new Error("fromLocationId and toLocationId must be different.");

    const [fromLocation, toLocation] = await Promise.all([
      CashLocationModel.findOne({ _id: fromLocationId, tenantId }),
      CashLocationModel.findOne({ _id: toLocationId, tenantId })
    ]);
    if (!fromLocation) throw new Error("Source cash location not found.");
    if (!toLocation) throw new Error("Destination cash location not found.");
    if (fromLocation.status !== "Opened") throw new Error(`Source cash location is not Opened (status: "${fromLocation.status}").`);
    if (toLocation.status !== "Opened") throw new Error(`Destination cash location is not Opened (status: "${toLocation.status}").`);
    if (fromLocation.currency !== toLocation.currency) throw new Error(`Currency mismatch: source is ${fromLocation.currency}, destination is ${toLocation.currency}.`);

    const roundedAmount = roundCurrency(amount);
    if (!(roundedAmount > 0)) throw new Error("A positive amount is required.");
    if (roundedAmount > fromLocation.balance) {
      throw new Error(`Insufficient cash at source: requested ${roundedAmount} ${fromLocation.currency}, available ${fromLocation.balance}.`);
    }

    const requiresDualAuthorization = fromLocation.dualAuthorizationRequired || toLocation.dualAuthorizationRequired;
    const approvalRequired = config.cashTransferApprovalRequired || requiresDualAuthorization;

    const transferNumber = await CashManagementService._generateCode(tenantId, "cashTransferNumber", config.cashTransferNumberPrefix);

    const transfer = await CashTransferModel.create({
      tenantId, transferNumber, fromLocationId, toLocationId, amount: roundedAmount, currency: fromLocation.currency, reason,
      // Always created as Pending Approval — when approval isn't required
      // this is immediately overwritten to "Completed" by
      // _completeCashTransfer below in the same call.
      status: config.defaultCashTransferStatus,
      requiresDualAuthorization,
      timeline: [{ event: "CashTransferInitiated", description: `Transfer of ${roundedAmount} ${fromLocation.currency} initiated.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.cash.transfer_initiate", module: "Finance", resource: "CashTransfer", resourceId: transfer._id.toString(), userId: userId || null, tenantId, details: { transferNumber, amount: roundedAmount, requiresDualAuthorization } });
    publishEvent("CashTransferInitiated", { tenantId, transferId: transfer._id.toString(), fromLocationId: fromLocationId.toString(), toLocationId: toLocationId.toString(), amount: roundedAmount, performedBy: userId || null });

    if (!approvalRequired) {
      return CashManagementService._completeCashTransfer(transfer, tenantId, userId);
    }

    return transfer.toJSON();
  }

  /**
   * POST /api/v1/cash-transfers/{transferId}/approve — single-approval
   * transfers complete on their one approval; dual-authorization transfers
   * (either location flagged `dualAuthorizationRequired`) need a SECOND,
   * DIFFERENT user's approval — the first approval alone moves status to
   * "Approved" (a real, distinct resting state only reachable this way),
   * not yet "Completed".
   */
  static async approveCashTransfer(transferId, tenantId, userId) {
    const transfer = await CashTransferModel.findOne({ _id: transferId, tenantId });
    if (!transfer) throw new Error("Cash transfer not found.");
    if (!isCashTransferApprovable(transfer.status)) throw new Error(`Cash transfer cannot be approved from status "${transfer.status}".`);
    if ((transfer.approvals || []).some((a) => a.approvedBy === (userId || null))) {
      throw new Error("This user has already approved this transfer — a second, different approver is required.");
    }

    transfer.approvals.push({ approvedBy: userId || null, approvedAt: new Date() });
    const required = requiredApprovalCount(transfer.requiresDualAuthorization);

    if (hasEnoughApprovals(transfer.approvals, required)) {
      return CashManagementService._completeCashTransfer(transfer, tenantId, userId);
    }

    transfer.status = "Approved";
    transfer.updatedBy = userId || null;
    transfer.timeline.push({ event: "CashTransferPartiallyApproved", description: `${transfer.approvals.length}/${required} approvals recorded.`, performedBy: userId || null });
    await transfer.save();

    await AuditLogModel.create({ action: "finance.cash.transfer_approve", module: "Finance", resource: "CashTransfer", resourceId: transfer._id.toString(), userId: userId || null, tenantId, details: { approvalsCount: transfer.approvals.length, required } });

    return transfer.toJSON();
  }

  static async _completeCashTransfer(transfer, tenantId, userId) {
    const [fromLocation, toLocation] = await Promise.all([
      CashLocationModel.findOne({ _id: transfer.fromLocationId, tenantId }).lean(),
      CashLocationModel.findOne({ _id: transfer.toLocationId, tenantId }).lean()
    ]);
    if (!fromLocation || !toLocation) throw new Error("A location involved in this transfer no longer exists.");
    if (transfer.amount > fromLocation.balance) {
      throw new Error(`Insufficient cash at source: requested ${transfer.amount} ${transfer.currency}, available ${fromLocation.balance}.`);
    }

    let journalId = null;
    if (fromLocation.glAccountCode && toLocation.glAccountCode) {
      const journal = await JournalService.createJournal({
        journalType: "Automatic",
        postingDate: new Date(),
        description: `Cash transfer ${transfer.transferNumber}: ${fromLocation.name} -> ${toLocation.name}`,
        referenceNumber: transfer.transferNumber,
        currency: transfer.currency,
        lines: [
          { accountCode: toLocation.glAccountCode, debit: transfer.amount },
          { accountCode: fromLocation.glAccountCode, credit: transfer.amount }
        ]
      }, tenantId, userId || "system");
      await JournalService.approveJournal(journal._id, tenantId, userId || "system");
      const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
      journalId = posted?._id || journal._id;
    }

    const { transaction: fromTransaction } = await CashManagementService.applyCashTransaction(transfer.fromLocationId, tenantId, {
      direction: "Debit", amount: transfer.amount, currency: transfer.currency, type: "TransferOut", sourceType: "CashTransfer", sourceId: transfer._id, description: transfer.reason, performedBy: userId || null
    });
    const { transaction: toTransaction } = await CashManagementService.applyCashTransaction(transfer.toLocationId, tenantId, {
      direction: "Credit", amount: transfer.amount, currency: transfer.currency, type: "TransferIn", sourceType: "CashTransfer", sourceId: transfer._id, description: transfer.reason, performedBy: userId || null
    });

    const finalTransfer = await CashTransferModel.findOneAndUpdate(
      { _id: transfer._id, tenantId },
      {
        $set: { status: "Completed", completedAt: new Date(), fromTransactionId: fromTransaction._id, toTransactionId: toTransaction._id, journalId, updatedBy: userId || null },
        $push: { timeline: { event: "CashTransferred", description: `Transfer of ${transfer.amount} ${transfer.currency} completed.`, performedBy: userId || null } }
      },
      { new: true }
    );

    await AuditLogModel.create({ action: "finance.cash.transfer_complete", module: "Finance", resource: "CashTransfer", resourceId: transfer._id.toString(), userId: userId || null, tenantId, details: { journalId: journalId ? journalId.toString() : null } });
    publishEvent("CashTransferred", { tenantId, transferId: transfer._id.toString(), fromLocationId: transfer.fromLocationId.toString(), toLocationId: transfer.toLocationId.toString(), amount: transfer.amount, performedBy: userId || null });

    return finalTransfer.toJSON();
  }

  /**
   * POST /api/v1/cash-transfers/{transferId}/reject — no domain event named.
   */
  static async rejectCashTransfer(transferId, data, tenantId, userId) {
    const transfer = await CashTransferModel.findOne({ _id: transferId, tenantId });
    if (!transfer) throw new Error("Cash transfer not found.");
    if (!isCashTransferRejectable(transfer.status)) throw new Error(`Cash transfer cannot be rejected from status "${transfer.status}".`);

    transfer.status = "Rejected";
    transfer.rejectedBy = userId || null;
    transfer.rejectedAt = new Date();
    transfer.rejectionReason = data?.reason || null;
    transfer.updatedBy = userId || null;
    transfer.timeline.push({ event: "CashTransferRejected", description: data?.reason || "Cash transfer rejected.", performedBy: userId || null });
    await transfer.save();

    await AuditLogModel.create({ action: "finance.cash.transfer_reject", module: "Finance", resource: "CashTransfer", resourceId: transfer._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return transfer.toJSON();
  }

  /**
   * POST /api/v1/cash-transfers/{transferId}/cancel — no domain event named.
   */
  static async cancelCashTransfer(transferId, data, tenantId, userId) {
    const transfer = await CashTransferModel.findOne({ _id: transferId, tenantId });
    if (!transfer) throw new Error("Cash transfer not found.");
    if (!isCashTransferCancellable(transfer.status)) throw new Error(`Cash transfer cannot be cancelled from status "${transfer.status}".`);

    transfer.status = "Cancelled";
    transfer.cancelledBy = userId || null;
    transfer.cancelledAt = new Date();
    transfer.cancellationReason = data?.reason || null;
    transfer.updatedBy = userId || null;
    transfer.timeline.push({ event: "CashTransferCancelled", description: data?.reason || "Cash transfer cancelled.", performedBy: userId || null });
    await transfer.save();

    await AuditLogModel.create({ action: "finance.cash.transfer_cancel", module: "Finance", resource: "CashTransfer", resourceId: transfer._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return transfer.toJSON();
  }

  static async listCashTransfers(query, tenantId) {
    const config = getFinanceConfig();
    const { fromLocation, toLocation, status, currency } = query;
    const filter = { tenantId };
    if (fromLocation) filter.fromLocationId = fromLocation;
    if (toLocation) filter.toLocationId = toLocation;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      CashTransferModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      CashTransferModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getCashTransferById(transferId, tenantId) {
    const transfer = await CashTransferModel.findOne({ _id: transferId, tenantId }).lean();
    if (!transfer) throw new Error("Cash transfer not found.");
    return transfer;
  }

  /**
   * POST /api/v1/cash-locations/{cashLocationId}/counts — "Opening Balance
   * -> Transactions -> Cash Count -> Expected Balance -> Actual Balance ->
   * Variance Report." `expectedBalance` is the location's real, live
   * ledger balance, never caller-supplied.
   */
  static async createCashCount(cashLocationId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { actualBalance, countType, notes = null } = data;

    if (actualBalance === undefined || actualBalance === null || actualBalance < 0) throw new Error("A non-negative actualBalance is required.");
    if (!config.cashCountTypes.includes(countType)) throw new Error(`Invalid countType "${countType}".`);

    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId }).lean();
    if (!cashLocation) throw new Error("Cash location not found.");

    const expectedBalance = cashLocation.balance;
    const roundedActual = roundCurrency(actualBalance);
    const variance = roundCurrency(roundedActual - expectedBalance);
    const varianceType = classifyVariance(variance, config.cashCountVarianceTolerance);
    const status = varianceType === "None" ? "Balanced" : "Variance Pending";

    const countNumber = await CashManagementService._generateCode(tenantId, "cashCountNumber", config.cashCountNumberPrefix);

    const count = await CashCountModel.create({
      tenantId, cashLocationId, countNumber, countType, expectedBalance, actualBalance: roundedActual,
      currency: cashLocation.currency, variance, varianceType, status, notes,
      countedBy: userId || null, countedAt: new Date(),
      createdBy: userId || null,
      timeline: [{ event: "CashCountCompleted", description: `${countType} count: expected ${expectedBalance}, actual ${roundedActual} (${varianceType}).`, performedBy: userId || null }]
    });

    await AuditLogModel.create({ action: "finance.cash.count", module: "Finance", resource: "CashCount", resourceId: count._id.toString(), userId: userId || null, tenantId, details: { countNumber, expectedBalance, actualBalance: roundedActual, variance, varianceType } });
    publishEvent("CashCountCompleted", { tenantId, countId: count._id.toString(), cashLocationId: cashLocationId.toString(), variance, varianceType, performedBy: userId || null });
    if (varianceType === "Shortage") publishEvent("CashShortageDetected", { tenantId, countId: count._id.toString(), cashLocationId: cashLocationId.toString(), amount: Math.abs(variance), performedBy: userId || null });
    if (varianceType === "Overage") publishEvent("CashOverageDetected", { tenantId, countId: count._id.toString(), cashLocationId: cashLocationId.toString(), amount: Math.abs(variance), performedBy: userId || null });

    return count.toJSON();
  }

  static async listCashCounts(query, tenantId) {
    const filter = { tenantId };
    if (query.cashLocation) filter.cashLocationId = query.cashLocation;
    if (query.status) filter.status = query.status;
    return CashCountModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getCashCountById(countId, tenantId) {
    const count = await CashCountModel.findOne({ _id: countId, tenantId }).lean();
    if (!count) throw new Error("Cash count not found.");
    return count;
  }

  /**
   * POST /api/v1/cash-counts/{countId}/resolve — gap-fill: no
   * `CashCountResolved` event is named, so none is invented. Posts a real
   * correcting entry: Shortage debits `cashShortageExpenseAccountCode`
   * (money is genuinely gone — an expense); Overage credits
   * `cashOverageIncomeAccountCode` (unexplained extra cash — income).
   */
  static async resolveCashCountVariance(countId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { notes } = data;
    if (!notes) throw new Error("notes is required — a reason is mandatory for any cash adjustment.");

    const count = await CashCountModel.findOne({ _id: countId, tenantId });
    if (!count) throw new Error("Cash count not found.");
    if (count.status !== "Variance Pending") throw new Error(`Cash count cannot be resolved from status "${count.status}".`);

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const cashLocation = await CashLocationModel.findOne({ _id: count.cashLocationId, tenantId }).lean();
    const isShortage = count.varianceType === "Shortage";
    const varianceAmount = roundCurrency(Math.abs(count.variance));

    let journalId = null;
    const counterAccountCode = isShortage ? config.cashShortageExpenseAccountCode : config.cashOverageIncomeAccountCode;
    if (cashLocation?.glAccountCode && counterAccountCode) {
      const lines = isShortage
        ? [{ accountCode: counterAccountCode, debit: varianceAmount }, { accountCode: cashLocation.glAccountCode, credit: varianceAmount }]
        : [{ accountCode: cashLocation.glAccountCode, debit: varianceAmount }, { accountCode: counterAccountCode, credit: varianceAmount }];
      const journal = await JournalService.createJournal({
        journalType: "Automatic",
        postingDate: new Date(),
        description: `Cash count ${count.countNumber} variance (${count.varianceType}): ${notes}`,
        referenceNumber: count.countNumber,
        currency: count.currency,
        lines
      }, tenantId, userId || "system");
      await JournalService.approveJournal(journal._id, tenantId, userId || "system");
      const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
      journalId = posted?._id || journal._id;
    }

    const { transaction } = await CashManagementService.applyCashTransaction(count.cashLocationId, tenantId, {
      direction: isShortage ? "Debit" : "Credit", amount: varianceAmount, currency: count.currency, type: "CountVarianceAdjustment", sourceType: "CashCount", sourceId: count._id, description: notes, performedBy: userId || null
    });

    count.status = "Resolved";
    count.adjustmentTransactionId = transaction._id;
    count.resolvedBy = userId || null;
    count.resolvedAt = new Date();
    count.resolutionNotes = notes;
    count.timeline.push({ event: "CashCountVarianceResolved", description: notes, performedBy: userId || null });
    await count.save();

    await AuditLogModel.create({ action: "finance.cash.resolve_variance", module: "Finance", resource: "CashCount", resourceId: count._id.toString(), userId: userId || null, tenantId, details: { varianceType: count.varianceType, amount: varianceAmount, journalId: journalId ? journalId.toString() : null } });

    return count.toJSON();
  }

  /**
   * POST /api/v1/cash-locations/{cashLocationId}/petty-cash/advances
   */
  static async issuePettyCashAdvance(cashLocationId, data, tenantId, userId) {
    const { issuedTo, amount, purpose } = data;
    if (!issuedTo || !amount || !purpose) throw new Error("issuedTo, amount, and purpose are required.");

    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId }).lean();
    if (!cashLocation) throw new Error("Cash location not found.");
    if (cashLocation.type !== "Petty Cash") throw new Error('Advances can only be issued from a "Petty Cash" location.');

    const employee = await UserModel.findById(issuedTo).lean();
    if (!employee) throw new Error("Employee not found.");

    const roundedAmount = roundCurrency(amount);
    const advanceNumber = await CashManagementService._generateCode(tenantId, "pettyCashAdvanceNumber", getFinanceConfig().pettyCashAdvanceNumberPrefix);

    const advance = await PettyCashAdvanceModel.create({
      tenantId, advanceNumber, cashLocationId, issuedTo, issuedToName: employee.username, amount: roundedAmount,
      currency: cashLocation.currency, purpose, outstandingAmount: roundedAmount, status: "Issued",
      issuedBy: userId || null, issuedAt: new Date(), createdBy: userId || null,
      timeline: [{ event: "PettyCashIssued", description: `Advance of ${roundedAmount} ${cashLocation.currency} issued to ${employee.username} for: ${purpose}.`, performedBy: userId || null }]
    });

    const { transaction } = await CashManagementService.applyCashTransaction(cashLocationId, tenantId, {
      direction: "Debit", amount: roundedAmount, currency: cashLocation.currency, type: "PettyCashAdvanceIssued", sourceType: "PettyCashAdvance", sourceId: advance._id, description: purpose, performedBy: userId || null
    });
    advance.issueTransactionId = transaction._id;
    await advance.save();

    await AuditLogModel.create({ action: "finance.cash.issue_petty_cash", module: "Finance", resource: "PettyCashAdvance", resourceId: advance._id.toString(), userId: userId || null, tenantId, details: { advanceNumber, amount: roundedAmount, issuedTo: issuedTo.toString() } });
    publishEvent("PettyCashIssued", { tenantId, advanceId: advance._id.toString(), cashLocationId: cashLocationId.toString(), issuedTo: issuedTo.toString(), amount: roundedAmount, performedBy: userId || null });

    return advance.toJSON();
  }

  /**
   * POST /api/v1/petty-cash/advances/{advanceId}/settle — the real CASH
   * side of accounting for how an advance was used; the full Expense
   * Claim workflow (categories, receipts/OCR, approval routing) is
   * explicitly Part 16's own scope, not rebuilt here. Only the
   * `returnedAmount` portion creates a new real cash movement (physical
   * cash coming back) — the `spentAmount` portion was already removed
   * from the location's ledger at issuance.
   */
  static async settlePettyCashAdvance(advanceId, data, tenantId, userId) {
    const { spentAmount = 0, returnedAmount = 0, description = null } = data;
    const totalAccountedFor = roundCurrency((spentAmount || 0) + (returnedAmount || 0));
    if (totalAccountedFor <= 0) throw new Error("spentAmount and/or returnedAmount must total more than zero.");

    const advance = await PettyCashAdvanceModel.findOne({ _id: advanceId, tenantId });
    if (!advance) throw new Error("Petty cash advance not found.");
    if (!isPettyCashAdvanceSettleable(advance.status)) throw new Error(`Advance cannot be settled from status "${advance.status}".`);
    if (totalAccountedFor > advance.outstandingAmount + 0.01) {
      throw new Error(`Settlement amount ${totalAccountedFor} exceeds the outstanding advance balance (${advance.outstandingAmount}).`);
    }

    let returnedTransactionId = null;
    if (returnedAmount > 0) {
      const { transaction } = await CashManagementService.applyCashTransaction(advance.cashLocationId, tenantId, {
        direction: "Credit", amount: roundCurrency(returnedAmount), currency: advance.currency, type: "PettyCashAdvanceSettled", sourceType: "PettyCashAdvance", sourceId: advance._id, description: description || "Unspent advance returned", performedBy: userId || null
      });
      returnedTransactionId = transaction._id;
    }

    advance.settlements.push({ amount: roundCurrency(spentAmount || 0), description, returnedTransactionId, settledBy: userId || null, settledAt: new Date() });
    advance.outstandingAmount = roundCurrency(advance.outstandingAmount - totalAccountedFor);
    advance.status = advance.outstandingAmount <= 0.01 ? "Settled" : "Partially Settled";
    advance.timeline.push({ event: "PettyCashSettled", description: `${totalAccountedFor} ${advance.currency} accounted for (${spentAmount || 0} spent, ${returnedAmount || 0} returned).`, performedBy: userId || null });
    await advance.save();

    await AuditLogModel.create({ action: "finance.cash.settle_petty_cash", module: "Finance", resource: "PettyCashAdvance", resourceId: advance._id.toString(), userId: userId || null, tenantId, details: { spentAmount: roundCurrency(spentAmount || 0), returnedAmount: roundCurrency(returnedAmount || 0) } });

    return advance.toJSON();
  }

  static async listPettyCashAdvances(query, tenantId) {
    const filter = { tenantId };
    if (query.cashLocation) filter.cashLocationId = query.cashLocation;
    if (query.issuedTo) filter.issuedTo = query.issuedTo;
    if (query.status) filter.status = query.status;
    return PettyCashAdvanceModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getPettyCashAdvanceById(advanceId, tenantId) {
    const advance = await PettyCashAdvanceModel.findOne({ _id: advanceId, tenantId }).lean();
    if (!advance) throw new Error("Petty cash advance not found.");
    return advance;
  }

  /**
   * POST /api/v1/cash-locations/{cashLocationId}/petty-cash/replenish —
   * "Replenishment" — tops a Petty Cash location back up. Funding source
   * reuses `bankAdjustmentSuspenseAccountCode` (Part 13) as the
   * counter-account rather than introducing a near-duplicate config field —
   * conceptually the same "generic clearing account a real funding source
   * posts through" role.
   */
  static async replenishPettyCash(cashLocationId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { amount, reason = "Petty cash replenishment" } = data;
    if (!amount || amount <= 0) throw new Error("A positive amount is required.");

    const cashLocation = await CashLocationModel.findOne({ _id: cashLocationId, tenantId }).lean();
    if (!cashLocation) throw new Error("Cash location not found.");
    if (cashLocation.type !== "Petty Cash") throw new Error('Only a "Petty Cash" location can be replenished.');

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const roundedAmount = roundCurrency(amount);
    let journalId = null;
    if (cashLocation.glAccountCode && config.bankAdjustmentSuspenseAccountCode) {
      const journal = await JournalService.createJournal({
        journalType: "Automatic",
        postingDate: new Date(),
        description: `Petty cash replenishment: ${reason}`,
        referenceNumber: cashLocation.cashLocationCode,
        currency: cashLocation.currency,
        lines: [
          { accountCode: cashLocation.glAccountCode, debit: roundedAmount },
          { accountCode: config.bankAdjustmentSuspenseAccountCode, credit: roundedAmount }
        ]
      }, tenantId, userId || "system");
      await JournalService.approveJournal(journal._id, tenantId, userId || "system");
      const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
      journalId = posted?._id || journal._id;
    }

    const { cashLocation: updated } = await CashManagementService.applyCashTransaction(cashLocationId, tenantId, {
      direction: "Credit", amount: roundedAmount, currency: cashLocation.currency, type: "PettyCashReplenishment", description: reason, performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.cash.replenish_petty_cash", module: "Finance", resource: "CashLocation", resourceId: cashLocationId.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, journalId: journalId ? journalId.toString() : null } });
    publishEvent("PettyCashReplenished", { tenantId, cashLocationId: cashLocationId.toString(), amount: roundedAmount, performedBy: userId || null });

    return updated;
  }

  /**
   * POST /api/v1/cash-management/forecast — "Cash Forecasting... AI
   * advisory only." Real LLM call through the same, already-wired
   * `AIModelRouterService` Part 14's own AI Matching uses — fed real
   * historical CashTransactionModel movement, never fabricated. Purely
   * informational: never auto-creates a transfer.
   */
  static async forecastCashNeeds(query, tenantId) {
    const filter = { tenantId };
    if (query.cashLocation) filter.cashLocationId = query.cashLocation;

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 90);
    filter.createdAt = { $gte: since };

    const [locations, recentTransactions] = await Promise.all([
      CashLocationModel.find({ tenantId, ...(query.cashLocation ? { _id: query.cashLocation } : {}), status: "Opened" }).select("name type currency balance targetFloatAmount").lean(),
      CashTransactionModel.find(filter).select("cashLocationId direction amount currency type createdAt").sort({ createdAt: -1 }).limit(500).lean()
    ]);

    if (locations.length === 0) return { aiAvailable: true, forecast: [], message: "No open cash locations to forecast against." };

    const systemPrompt = "You are a cash management forecasting assistant for an ERP. Given a list of cash locations (current balances, target float amounts) and their recent transaction history, predict near-term cash needs. Respond with ONLY JSON, no prose, in this exact shape: {\"forecast\":[{\"cashLocationId\":\"...\",\"predictedDailyNeed\":number,\"shortageRiskLevel\":\"Low\"|\"Medium\"|\"High\",\"transferRecommendation\":\"...\"}]}. This is advisory only — nothing will be executed automatically.";
    const userPrompt = `Cash locations:\n${JSON.stringify(locations.map((l) => ({ id: l._id.toString(), name: l.name, type: l.type, currency: l.currency, balance: l.balance, targetFloatAmount: l.targetFloatAmount })))}\n\nRecent transactions (last 90 days, up to 500):\n${JSON.stringify(recentTransactions.map((t) => ({ cashLocationId: t.cashLocationId.toString(), direction: t.direction, amount: t.amount, type: t.type, date: t.createdAt })))}`;

    let llmResult;
    try {
      llmResult = await AIModelRouterService.route({ tenantId, category: "reasoning", messages: [{ role: "user", content: userPrompt }], tools: [], systemPrompt });
    } catch (error) {
      return { aiAvailable: false, forecast: [], message: error.message };
    }

    let forecast = [];
    try {
      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(jsonText);
      forecast = Array.isArray(parsed.forecast) ? parsed.forecast : [];
    } catch {
      return { aiAvailable: true, forecast: [], message: "The AI did not return a valid forecast." };
    }

    const validLocationIds = new Set(locations.map((l) => l._id.toString()));
    const validForecast = forecast.filter((f) => validLocationIds.has(f.cashLocationId));

    return { aiAvailable: true, forecast: validForecast, provider: llmResult.provider, model: llmResult.model };
  }
}

export default CashManagementService;
