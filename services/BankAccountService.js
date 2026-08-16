import BankAccountModel from "../models/BankAccountModel.js";
import BankTransactionModel from "../models/BankTransactionModel.js";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import PaymentModel from "../models/PaymentModel.js";
import RefundModel from "../models/RefundModel.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { encryptField, hashField } from "../utils/fieldEncryption.js";
import { subscribeEvent, publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/bankAccountService.test.js).
// ---------------------------------------------------------------------------

const TRANSACTABLE_STATUSES = new Set(["Active"]);
const FREEZABLE_STATUSES = new Set(["Verified", "Active"]);
const REOPENABLE_STATUSES = new Set(["Frozen", "Suspended"]);
const CLOSEABLE_STATUSES = new Set(["Verified", "Active", "Frozen", "Suspended"]);

export const isBankAccountVerifiable = (status) => status === "Pending Verification";
export const isBankAccountActivatable = (status) => status === "Verified";
export const isBankAccountFreezable = (status) => FREEZABLE_STATUSES.has(status);
export const isBankAccountReopenable = (status) => REOPENABLE_STATUSES.has(status);
export const isBankAccountSuspendable = (status) => status === "Active";
export const isBankAccountCloseable = (status) => CLOSEABLE_STATUSES.has(status);
export const isBankAccountArchivable = (status) => status === "Closed";
export const isBankAccountTransactable = (status) => TRANSACTABLE_STATUSES.has(status);

/**
 * "Linked Services: Payment Engine..." — a Payment's `paymentType`
 * determines which direction money moves on the linked bank account.
 * Customer/Advance/Deposit payments are money coming IN (Credit); Vendor/
 * Employee payments are money going OUT (Debit).
 */
export const resolvePaymentBankDirection = (paymentType) => (["Vendor", "Employee"].includes(paymentType) ? "Debit" : "Credit");

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class BankAccountService {
  /**
   * Wires the real "Payment Engine"/"Refund Engine" integration the spec's
   * own architecture diagram draws — via the event bus, not a direct
   * service-to-service call, matching this codebase's established
   * cross-module pattern (identical in spirit to
   * RefundService.initEventListeners subscribing to Part 10's
   * RefundRequested). Only acts when the event payload carries a
   * `bankAccountId` — a Payment/Refund created without one (the common
   * case today, since neither module required one before this Part) simply
   * never touches a bank account, exactly as before.
   */
  static _eventListenersInitialized = false;
  static initEventListeners() {
    if (BankAccountService._eventListenersInitialized) return;
    BankAccountService._eventListenersInitialized = true;

    subscribeEvent("PaymentCaptured", async (payload) => {
      if (!payload?.tenantId || !payload?.bankAccountId || !payload?.paymentId) return;
      try {
        const payment = await PaymentModel.findOne({ _id: payload.paymentId, tenantId: payload.tenantId }).lean();
        if (!payment) return;
        await BankAccountService.applyTransaction(payload.bankAccountId, payload.tenantId, {
          direction: resolvePaymentBankDirection(payment.paymentType),
          amount: payment.amount,
          currency: payment.currency,
          type: "Payment",
          sourceType: "Payment",
          sourceId: payment._id,
          description: `Payment ${payment.paymentNumber} (${payment.paymentType})`,
          performedBy: payload.performedBy || "system"
        });
      } catch (error) {
        console.error("BankAccountService.PaymentCaptured handler failed:", error.message);
      }
    });

    subscribeEvent("RefundCompleted", async (payload) => {
      if (!payload?.tenantId || !payload?.bankAccountId || !payload?.refundId) return;
      try {
        const refund = await RefundModel.findOne({ _id: payload.refundId, tenantId: payload.tenantId }).lean();
        if (!refund) return;
        await BankAccountService.applyTransaction(payload.bankAccountId, payload.tenantId, {
          direction: "Debit",
          amount: refund.refundAmount,
          currency: refund.currency,
          type: "Refund",
          sourceType: "Refund",
          sourceId: refund._id,
          description: `Refund ${refund.refundNumber}`,
          performedBy: payload.performedBy || "system"
        });
      } catch (error) {
        console.error("BankAccountService.RefundCompleted handler failed:", error.message);
      }
    });
  }

  static async _generateBankAccountCode(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "bankAccountCode", year);
    return `${config.bankAccountCodePrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  static async _generateTransactionNumber(tenantId) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "bankTransactionNumber", year);
    return `BTX-${year}-${String(seq).padStart(8, "0")}`;
  }

  /** Lean-query results skip the model's own toJSON transform — this replicates it. */
  static _sanitize(doc) {
    if (!doc) return doc;
    const { accountNumberEncrypted, accountNumberHash, ...rest } = doc;
    return { ...rest, accountNumberMasked: doc.accountNumberLast4 ? `****${doc.accountNumberLast4}` : null };
  }

  /**
   * POST /api/v1/bank-accounts
   * Validate Currency -> Validate Bank -> Approval Workflow -> Generate
   * Account Code -> Audit -> Publish BankAccountCreated. "Validate
   * Organization"/"Legal Entity Exists" collapse into the tenant check
   * already performed by every controller via getAccessScope — no separate
   * Organization/Legal Entity model exists in this codebase to validate
   * against beyond the tenant itself.
   */
  static async createBankAccount(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { bankName, accountName, accountNumber, currency, accountType, iban = null, swiftCode = null, glAccountCode = null, linkedGateways = [], authorizedUsers = [] } = data;

    if (!bankName || !accountName || !accountNumber || !currency || !accountType) {
      throw new Error("bankName, accountName, accountNumber, currency, and accountType are required.");
    }
    if (!config.supportedCurrencies.includes(currency)) throw new Error(`Unsupported currency "${currency}".`);
    if (!config.bankAccountTypes.includes(accountType)) throw new Error(`Invalid accountType "${accountType}".`);

    const accountNumberHash = hashField(accountNumber);
    const existing = await BankAccountModel.findOne({ tenantId, accountNumberHash }).lean();
    if (existing) throw new Error("A bank account with this account number already exists.");

    if (glAccountCode) {
      const glAccount = await ChartOfAccountModel.findOne({ tenantId, accountCode: glAccountCode }).lean();
      if (!glAccount) throw new Error(`Chart of Accounts entry "${glAccountCode}" not found.`);
    }

    const bankAccountCode = await BankAccountService._generateBankAccountCode(tenantId);
    const normalizedNumber = String(accountNumber).trim();

    const bankAccount = await BankAccountModel.create({
      tenantId,
      bankAccountCode,
      bankName,
      accountName,
      accountNumberEncrypted: encryptField(normalizedNumber),
      accountNumberHash,
      accountNumberLast4: normalizedNumber.slice(-4),
      iban,
      swiftCode,
      currency,
      accountType,
      glAccountCode,
      linkedGateways,
      authorizedUsers: authorizedUsers.map((u) => ({ userId: u.userId, role: u.role || null, addedBy: userId || null })),
      status: config.defaultBankAccountStatus,
      timeline: [{ event: "BankAccountCreated", description: `Bank account ${bankAccountCode} (${bankName}) created.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.bankaccount.create", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { bankAccountCode, bankName, currency, accountType } });
    publishEvent("BankAccountCreated", { tenantId, bankAccountId: bankAccount._id.toString(), bankAccountCode, currency, accountType, performedBy: userId || null });

    return bankAccount.toJSON();
  }

  /**
   * GET /api/v1/bank-accounts
   */
  static async listBankAccounts(query, tenantId) {
    const config = getFinanceConfig();
    const { currency, status, bank, accountType, isVirtual } = query;
    const filter = { tenantId };
    if (currency) filter.currency = currency;
    if (status) filter.status = status;
    if (bank) filter.bankName = bank;
    if (accountType) filter.accountType = accountType;
    if (isVirtual === "true" || isVirtual === true) filter.isVirtual = true;
    if (isVirtual === "false" || isVirtual === false) filter.isVirtual = false;

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
      BankAccountModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      BankAccountModel.countDocuments(filter)
    ]);

    return { items: items.map(BankAccountService._sanitize), pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * GET /api/v1/bank-accounts/{accountId}
   */
  static async getBankAccountById(bankAccountId, tenantId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).populate("settlementAccountIds", "bankAccountCode bankName accountName accountType").lean();
    if (!bankAccount) throw new Error("Bank account not found.");

    const [recentTransactions, auditSummary] = await Promise.all([
      BankTransactionModel.find({ tenantId, bankAccountId }).sort({ createdAt: -1 }).limit(20).lean(),
      AuditLogModel.find({ tenantId, resource: "BankAccount", resourceId: bankAccount._id.toString() }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    return { ...BankAccountService._sanitize(bankAccount), recentTransactions, auditSummary };
  }

  /**
   * PATCH /api/v1/bank-accounts/{accountId} — gap-fill, mirrors
   * ChartOfAccountController's own updateAccount precedent: non-financial
   * metadata only (`bankName`, `accountName`, `glAccountCode`,
   * `linkedGateways`, `authorizedUsers`). `accountNumber`/`currency`/
   * `bankAccountCode` are never editable after creation — same "close this
   * account and open a new one" standard banking practice, and the same
   * "immutable core identity" discipline `accountCode` already gets on
   * Chart of Accounts.
   */
  static async updateBankAccount(bankAccountId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");

    const { bankName, accountName, glAccountCode, linkedGateways, authorizedUsers } = data;
    if (bankName !== undefined) bankAccount.bankName = bankName;
    if (accountName !== undefined) bankAccount.accountName = accountName;
    if (glAccountCode !== undefined) {
      if (glAccountCode) {
        const glAccount = await ChartOfAccountModel.findOne({ tenantId, accountCode: glAccountCode }).lean();
        if (!glAccount) throw new Error(`Chart of Accounts entry "${glAccountCode}" not found.`);
      }
      bankAccount.glAccountCode = glAccountCode;
    }
    if (linkedGateways !== undefined) bankAccount.linkedGateways = linkedGateways;
    if (authorizedUsers !== undefined) bankAccount.authorizedUsers = authorizedUsers.map((u) => ({ userId: u.userId, role: u.role || null, addedBy: userId || null }));

    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountUpdated", description: "Bank account details updated.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.update", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: {} });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/verify — gap-fill. Pending
   * Verification -> Verified. No external bank-verification API exists in
   * this codebase (no Open Banking/SWIFT integration — see this Part's own
   * Deferred section), so this represents finance-ops manually confirming
   * the bank details are correct, a genuine real-world control.
   */
  static async verifyBankAccount(bankAccountId, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountVerifiable(bankAccount.status)) throw new Error(`Bank account cannot be verified from status "${bankAccount.status}".`);

    bankAccount.status = "Verified";
    bankAccount.verifiedBy = userId || null;
    bankAccount.verifiedAt = new Date();
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountVerified", description: "Bank account verified.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.verify", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("BankAccountVerified", { tenantId, bankAccountId: bankAccount._id.toString(), performedBy: userId || null });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/activate — gap-fill. Verified ->
   * Active. "Active" and the spec's own "Operational" lifecycle state are
   * treated as one real state — see utils/financeConfig.js's own doc
   * comment for why no distinct trigger/event separates them.
   */
  static async activateBankAccount(bankAccountId, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountActivatable(bankAccount.status)) throw new Error(`Bank account cannot be activated from status "${bankAccount.status}".`);

    bankAccount.status = "Active";
    bankAccount.activatedBy = userId || null;
    bankAccount.activatedAt = new Date();
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountActivated", description: "Bank account activated.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.activate", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("BankAccountActivated", { tenantId, bankAccountId: bankAccount._id.toString(), performedBy: userId || null });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/freeze — the whole account stops
   * accepting transactions (distinct from a `hold`, which reserves part of
   * an otherwise-Active account's balance — see hold()/releaseHold() below).
   */
  static async freezeBankAccount(bankAccountId, data, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountFreezable(bankAccount.status)) throw new Error(`Bank account cannot be frozen from status "${bankAccount.status}".`);

    bankAccount.status = "Frozen";
    bankAccount.frozenBy = userId || null;
    bankAccount.frozenAt = new Date();
    bankAccount.frozenReason = data?.reason || null;
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountFrozen", description: data?.reason || "Bank account frozen.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.freeze", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("BankAccountFrozen", { tenantId, bankAccountId: bankAccount._id.toString(), reason: data?.reason || null, performedBy: userId || null });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/reopen — gap-fill: "Reopen
   * Account" is named under Approval Policies with no Lifecycle arrow or
   * domain event of its own; Frozen/Suspended -> Active.
   */
  static async reopenBankAccount(bankAccountId, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountReopenable(bankAccount.status)) throw new Error(`Bank account cannot be reopened from status "${bankAccount.status}".`);

    bankAccount.status = "Active";
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountReopened", description: "Bank account reopened.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.reopen", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: {} });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/suspend — gap-fill, no domain
   * event named for this transition either.
   */
  static async suspendBankAccount(bankAccountId, data, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountSuspendable(bankAccount.status)) throw new Error(`Bank account cannot be suspended from status "${bankAccount.status}".`);

    bankAccount.status = "Suspended";
    bankAccount.suspendedBy = userId || null;
    bankAccount.suspendedAt = new Date();
    bankAccount.suspendedReason = data?.reason || null;
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountSuspended", description: data?.reason || "Bank account suspended.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.suspend", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/close
   */
  static async closeBankAccount(bankAccountId, data, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountCloseable(bankAccount.status)) throw new Error(`Bank account cannot be closed from status "${bankAccount.status}".`);
    if (bankAccount.balances.current !== 0) {
      throw new Error(`Bank account has a non-zero balance (${bankAccount.balances.current} ${bankAccount.currency}) and cannot be closed until it is settled to zero.`);
    }

    bankAccount.status = "Closed";
    bankAccount.closedBy = userId || null;
    bankAccount.closedAt = new Date();
    bankAccount.closedReason = data?.reason || null;
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountClosed", description: data?.reason || "Bank account closed.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.close", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("BankAccountClosed", { tenantId, bankAccountId: bankAccount._id.toString(), reason: data?.reason || null, performedBy: userId || null });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/archive — gap-fill, terminal,
   * Closed only. No domain event named.
   */
  static async archiveBankAccount(bankAccountId, tenantId, userId) {
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountArchivable(bankAccount.status)) throw new Error(`Bank account cannot be archived from status "${bankAccount.status}".`);

    bankAccount.status = "Archived";
    bankAccount.archivedBy = userId || null;
    bankAccount.archivedAt = new Date();
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "BankAccountArchived", description: "Bank account archived.", performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.archive", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: {} });

    return bankAccount.toJSON();
  }

  /**
   * Internal primitive — the real Balance Engine every real money-movement
   * point in this codebase goes through (BankAccountService's own event
   * listeners above, and manualAdjustment below). Never exposed directly as
   * its own endpoint. A transaction against a virtual account is redirected
   * to its `parentAccountId` — "Virtual Accounts... Automatically mapped to
   * master account" — a virtual account never carries its own real balance.
   */
  static async applyTransaction(bankAccountId, tenantId, { direction, amount, currency, type, sourceType = null, sourceId = null, description = null, performedBy = null }) {
    let bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");

    if (bankAccount.isVirtual && bankAccount.parentAccountId) {
      bankAccount = await BankAccountModel.findOne({ _id: bankAccount.parentAccountId, tenantId });
      if (!bankAccount) throw new Error("Linked master bank account not found.");
    }

    if (!isBankAccountTransactable(bankAccount.status)) {
      throw new Error(`Bank account is not transactable in status "${bankAccount.status}".`);
    }
    if (currency && bankAccount.currency !== currency) {
      throw new Error(`Currency mismatch: transaction is ${currency}, bank account is ${bankAccount.currency}.`);
    }

    const roundedAmount = roundCurrency(amount);
    if (!(roundedAmount > 0)) throw new Error("Transaction amount must be greater than zero.");

    bankAccount.balances.current = roundCurrency(direction === "Credit" ? bankAccount.balances.current + roundedAmount : bankAccount.balances.current - roundedAmount);
    bankAccount.balances.available = roundCurrency(bankAccount.balances.current - bankAccount.balances.frozen);
    bankAccount.timeline.push({ event: "BalanceUpdated", description: `${direction} of ${roundedAmount} ${bankAccount.currency} (${type}).`, performedBy: performedBy || null });
    await bankAccount.save();

    const transactionNumber = await BankAccountService._generateTransactionNumber(tenantId);
    const transaction = await BankTransactionModel.create({
      tenantId,
      bankAccountId: bankAccount._id,
      transactionNumber,
      direction,
      amount: roundedAmount,
      currency: bankAccount.currency,
      balanceAfter: bankAccount.balances.current,
      type,
      sourceType,
      sourceId,
      description,
      performedBy
    });

    publishEvent("BalanceUpdated", { tenantId, bankAccountId: bankAccount._id.toString(), direction, amount: roundedAmount, currency: bankAccount.currency, balanceAfter: bankAccount.balances.current, type, performedBy: performedBy || null });

    // Returns both the updated account AND the real ledger entry just
    // created — Part 14 (Bank Reconciliation) needs the transaction's own
    // id to link a reconciliation adjustment back to it; every existing
    // caller (this file's own manualAdjustment, and the PaymentCaptured/
    // RefundCompleted event listeners above) either already expects this
    // shape or never destructured the previous bank-account-only return
    // value, so this is a safe, non-breaking refinement.
    return { bankAccount: bankAccount.toJSON(), transaction: transaction.toJSON() };
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/adjust-balance — gap-fill:
   * `BalanceUpdated` is a named domain event with no endpoint contracted to
   * reach it directly (only reachable internally via Payment/Refund
   * settlement until now). Real uses: entering an opening balance, bank
   * fees, interest, or any correction — posts a real double-entry journal
   * when the account's own `glAccountCode` is configured (Debit/Credit
   * mirrored against `bankAdjustmentSuspenseAccountCode`).
   */
  static async manualAdjustment(bankAccountId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { direction, amount, reason } = data;
    if (!["Credit", "Debit"].includes(direction)) throw new Error('direction must be "Credit" or "Debit".');
    if (!amount || amount <= 0) throw new Error("A positive amount is required.");
    if (!reason) throw new Error("reason is required.");

    await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());

    const accountBefore = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).lean();
    if (!accountBefore) throw new Error("Bank account not found.");

    let journalId = null;
    if (accountBefore.glAccountCode && config.bankAdjustmentSuspenseAccountCode) {
      const lines = direction === "Credit"
        ? [{ accountCode: accountBefore.glAccountCode, debit: roundCurrency(amount) }, { accountCode: config.bankAdjustmentSuspenseAccountCode, credit: roundCurrency(amount) }]
        : [{ accountCode: config.bankAdjustmentSuspenseAccountCode, debit: roundCurrency(amount) }, { accountCode: accountBefore.glAccountCode, credit: roundCurrency(amount) }];
      const journal = await JournalService.createJournal({
        journalType: "Automatic",
        postingDate: new Date(),
        description: `Manual bank adjustment: ${reason}`,
        referenceNumber: accountBefore.bankAccountCode,
        currency: accountBefore.currency,
        lines
      }, tenantId, userId || "system");
      await JournalService.approveJournal(journal._id, tenantId, userId || "system");
      const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
      journalId = posted?._id || journal._id;
    }

    const { bankAccount, transaction } = await BankAccountService.applyTransaction(bankAccountId, tenantId, {
      direction, amount, currency: accountBefore.currency, type: "ManualAdjustment", description: reason, performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.bankaccount.adjust_balance", module: "Finance", resource: "BankAccount", resourceId: bankAccountId.toString(), userId: userId || null, tenantId, details: { direction, amount: roundCurrency(amount), reason, journalId: journalId ? journalId.toString() : null } });

    return { bankAccount, transaction, journalId };
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/hold — reserves part of an
   * Active account's balance ("Frozen Balance"/"Reserved Funds" — the spec
   * names no distinguishing trigger between those two Balance Types, so
   * they're treated as the one `balances.frozen` field). Unlike `freeze`,
   * the account keeps transacting normally — only `available` shrinks. No
   * real cash moves, so this does NOT write a BankTransactionModel entry
   * (that ledger represents actual money movement only) — the account's
   * own timeline + AuditLogModel carry this event's trail instead.
   */
  static async hold(bankAccountId, data, tenantId, userId) {
    const { amount, reason } = data;
    if (!amount || amount <= 0) throw new Error("A positive amount is required.");

    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (!isBankAccountTransactable(bankAccount.status)) throw new Error(`Bank account cannot hold funds in status "${bankAccount.status}".`);

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount > bankAccount.balances.available) {
      throw new Error(`Hold amount ${roundedAmount} exceeds the available balance (${bankAccount.balances.available}).`);
    }

    bankAccount.balances.frozen = roundCurrency(bankAccount.balances.frozen + roundedAmount);
    bankAccount.balances.available = roundCurrency(bankAccount.balances.current - bankAccount.balances.frozen);
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "FundsHeld", description: `${roundedAmount} ${bankAccount.currency} held${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.hold", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, reason: reason || null } });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/release-hold
   */
  static async releaseHold(bankAccountId, data, tenantId, userId) {
    const { amount, reason } = data;
    if (!amount || amount <= 0) throw new Error("A positive amount is required.");

    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount > bankAccount.balances.frozen) {
      throw new Error(`Release amount ${roundedAmount} exceeds the frozen balance (${bankAccount.balances.frozen}).`);
    }

    bankAccount.balances.frozen = roundCurrency(bankAccount.balances.frozen - roundedAmount);
    bankAccount.balances.available = roundCurrency(bankAccount.balances.current - bankAccount.balances.frozen);
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "FundsReleased", description: `${roundedAmount} ${bankAccount.currency} released${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.release_hold", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, reason: reason || null } });

    return bankAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/virtual-accounts — gap-fill:
   * `VirtualAccountCreated` is a named domain event with no endpoint
   * contracted for it. A virtual account rides on its master's already-
   * verified banking relationship — no separate bank verification is
   * meaningful for it, so it's created directly `Active` rather than
   * re-running Pending Verification -> Verified.
   */
  static async createVirtualAccount(masterAccountId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const master = await BankAccountModel.findOne({ _id: masterAccountId, tenantId }).lean();
    if (!master) throw new Error("Master bank account not found.");
    if (master.isVirtual) throw new Error("Cannot create a virtual account under another virtual account.");

    const { accountName, accountNumber } = data;
    if (!accountName || !accountNumber) throw new Error("accountName and accountNumber are required.");

    const accountNumberHash = hashField(accountNumber);
    const existing = await BankAccountModel.findOne({ tenantId, accountNumberHash }).lean();
    if (existing) throw new Error("A bank account with this account number already exists.");

    const bankAccountCode = await BankAccountService._generateBankAccountCode(tenantId);
    const normalizedNumber = String(accountNumber).trim();

    const virtualAccount = await BankAccountModel.create({
      tenantId,
      bankAccountCode,
      bankName: master.bankName,
      accountName,
      accountNumberEncrypted: encryptField(normalizedNumber),
      accountNumberHash,
      accountNumberLast4: normalizedNumber.slice(-4),
      currency: master.currency,
      accountType: "Virtual Account",
      isVirtual: true,
      parentAccountId: master._id,
      status: "Active",
      activatedBy: userId || null,
      activatedAt: new Date(),
      timeline: [{ event: "VirtualAccountCreated", description: `Virtual account ${bankAccountCode} mapped to master ${master.bankAccountCode}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.bankaccount.create_virtual", module: "Finance", resource: "BankAccount", resourceId: virtualAccount._id.toString(), userId: userId || null, tenantId, details: { masterAccountId: masterAccountId.toString(), bankAccountCode } });
    publishEvent("VirtualAccountCreated", { tenantId, bankAccountId: virtualAccount._id.toString(), parentAccountId: master._id.toString(), performedBy: userId || null });

    return virtualAccount.toJSON();
  }

  /**
   * POST /api/v1/bank-accounts/{accountId}/link-settlement-account —
   * gap-fill: `SettlementAccountLinked` is a named domain event with no
   * endpoint contracted for it.
   */
  static async linkSettlementAccount(bankAccountId, data, tenantId, userId) {
    const { settlementAccountId } = data;
    if (!settlementAccountId) throw new Error("settlementAccountId is required.");
    if (settlementAccountId === bankAccountId) throw new Error("A bank account cannot settle into itself.");

    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId });
    if (!bankAccount) throw new Error("Bank account not found.");

    const settlementAccount = await BankAccountModel.findOne({ _id: settlementAccountId, tenantId }).lean();
    if (!settlementAccount) throw new Error("Settlement bank account not found.");

    const alreadyLinked = bankAccount.settlementAccountIds.some((id) => id.toString() === settlementAccountId.toString());
    if (alreadyLinked) throw new Error("This settlement account is already linked.");

    bankAccount.settlementAccountIds.push(settlementAccountId);
    bankAccount.updatedBy = userId || null;
    bankAccount.timeline.push({ event: "SettlementAccountLinked", description: `Linked settlement account ${settlementAccount.bankAccountCode}.`, performedBy: userId || null });
    await bankAccount.save();

    await AuditLogModel.create({ action: "finance.bankaccount.link_settlement", module: "Finance", resource: "BankAccount", resourceId: bankAccount._id.toString(), userId: userId || null, tenantId, details: { settlementAccountId: settlementAccountId.toString() } });
    publishEvent("SettlementAccountLinked", { tenantId, bankAccountId: bankAccount._id.toString(), settlementAccountId: settlementAccountId.toString(), performedBy: userId || null });

    return bankAccount.toJSON();
  }

  /**
   * GET /api/v1/bank-accounts/{accountId}/transactions
   */
  static async listTransactions(bankAccountId, query, tenantId) {
    const config = getFinanceConfig();
    const bankAccount = await BankAccountModel.findOne({ _id: bankAccountId, tenantId }).lean();
    if (!bankAccount) throw new Error("Bank account not found.");

    const filter = { tenantId, bankAccountId };
    if (query.direction) filter.direction = query.direction;
    if (query.type) filter.type = query.type;
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      BankTransactionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      BankTransactionModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }
}

export default BankAccountService;
