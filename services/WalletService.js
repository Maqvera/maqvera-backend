import WalletModel from "../models/WalletModel.js";
import WalletTransactionModel from "../models/WalletTransactionModel.js";
import CustomerModel from "../models/CustomerModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import PaymentService from "./PaymentService.js";
import JournalService from "./JournalService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly.
// ---------------------------------------------------------------------------

export const isWalletUsable = (status) => status === "Active";
export const hasSufficientBalance = (balance, amount) => roundCurrency(balance) >= roundCurrency(amount);

/**
 * Enterprise Customer Payments — Finance Module Part 18 Part 4. "Wallet
 * Support... Top-Up -> Wallet Balance -> Purchase -> Refund -> Transfer ->
 * Withdrawal (Optional). Every wallet transaction is immutable." A
 * purchase never re-implements the Payment Engine/Allocation Engine — it
 * spends the wallet's own already-real balance THROUGH the exact same
 * `CustomerCollectionService.collectPayment` flow every other payment
 * method uses, with `paymentMethod: "Wallet"` (resolved to the honest
 * "Manual" gateway — see PaymentService's own `MANUAL_ONLY_METHODS`), so
 * fraud scoring, allocation, receipts, and ledger posting are the exact
 * same real code path, not a parallel one.
 */
class WalletService {
  static async _generateWalletNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "walletNumber", year);
    return `${config.walletNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /** "WalletBalanceUpdated" (Part 18 Part 5's own Domain Events list) — one unified event alongside the more specific WalletToppedUp/Debited/Credited/Transferred ones, for consumers that only care about the resulting balance. */
  static _publishBalanceUpdated(tenantId, wallet, userId) {
    publishEvent("WalletBalanceUpdated", { tenantId, walletId: wallet._id.toString(), customerId: wallet.customerId.toString(), balance: wallet.balance, currency: wallet.currency, performedBy: userId || null });
  }

  static async _postWalletJournal({ tenantId, userId, description, currency, referenceNumber, lines }) {
    const config = getFinanceConfig();
    if (!config.defaultCashAccountCode || !config.walletLiabilityAccountCode) return null;
    const journal = await JournalService.createJournal({
      journalType: "Automatic", postingDate: new Date(), description, referenceNumber, currency, lines
    }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    return JournalService.postJournal(journal._id, tenantId, userId || "system");
  }

  /** POST /api/v1/wallets — creates (or returns, idempotently) the one real wallet for this customer/type/currency. */
  static async createWallet(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { customerId, walletType = config.defaultWalletType, currency, maxBalance = null } = data;
    if (!customerId || !currency) throw new Error("customerId and currency are required.");
    if (!config.walletTypes.includes(walletType)) throw new Error(`Invalid walletType "${walletType}".`);
    if (!config.supportedCurrencies.some((c) => c.toLowerCase() === String(currency).toLowerCase())) throw new Error(`Currency "${currency}" is not supported.`);

    const existing = await WalletModel.findOne({ tenantId, customerId, walletType, currency }).lean();
    if (existing) return existing;

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");
    const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || "Customer";

    const walletNumber = await WalletService._generateWalletNumber(tenantId);
    const wallet = await WalletModel.create({
      tenantId, walletNumber, customerId, customerName, walletType, currency, balance: 0,
      status: config.defaultWalletStatus, maxBalance,
      timeline: [{ event: "WalletCreated", description: `${walletType} wallet created (${currency}).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.wallet.create", module: "Finance", resource: "Wallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId, details: { walletNumber, walletType, currency } });
    return wallet.toJSON();
  }

  static async getOrCreateWallet({ customerId, walletType, currency }, tenantId, userId) {
    return WalletService.createWallet({ customerId, walletType, currency }, tenantId, userId);
  }

  static async getWalletById(walletId, tenantId) {
    const wallet = await WalletModel.findOne({ _id: walletId, tenantId });
    if (!wallet) throw new Error("Wallet not found.");
    return wallet;
  }

  static async listWallets(query, tenantId) {
    const { customerId, walletType, status } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (walletType) filter.walletType = walletType;
    if (status) filter.status = status;
    return WalletModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async listTransactions(walletId, tenantId, query = {}) {
    const filter = { tenantId, walletId };
    if (query.type) filter.type = query.type;
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
    return WalletTransactionModel.find(filter).sort({ createdAt: -1 }).limit(pageSize).lean();
  }

  /**
   * POST /api/v1/wallets/{walletId}/topup — real money in via the Payment
   * Engine (Part 7), Automatic capture. Posts a real Dr Cash / Cr Wallet
   * Liability journal when both account codes are configured (same
   * opt-in discipline AR's own allocation journal uses) — never fabricated
   * when unconfigured.
   */
  static async topUp(walletId, data, tenantId, userId) {
    const { amount, paymentMethod, paymentProvider = null } = data;
    if (!amount || amount <= 0) throw new Error("amount must be greater than zero.");
    if (!paymentMethod) throw new Error("paymentMethod is required.");

    const wallet = await WalletService.getWalletById(walletId, tenantId);
    if (!isWalletUsable(wallet.status)) throw new Error(`Wallet is not usable (status "${wallet.status}").`);
    const roundedAmount = roundCurrency(amount);
    if (wallet.maxBalance && roundCurrency(wallet.balance + roundedAmount) > wallet.maxBalance) {
      throw new Error(`Top-up would exceed this wallet's maximum balance (${wallet.maxBalance}).`);
    }

    const payment = await PaymentService.createPayment({
      paymentType: "Customer", partyType: "customer", partyId: wallet.customerId, amount: roundedAmount,
      currency: wallet.currency, paymentMethod, gateway: paymentProvider || undefined, reference: wallet.walletNumber
    }, tenantId, userId);

    if (payment.status === "Failed") {
      await AuditLogModel.create({ action: "finance.wallet.topup", module: "Finance", resource: "Wallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId, details: { failed: true, reason: payment.failureReason || null } });
      return { wallet: wallet.toJSON(), payment, transaction: null };
    }

    await PaymentService.consumeUnallocatedAmount(payment._id, tenantId, roundedAmount, { targetType: "Wallet", targetId: wallet._id, allocatedBy: userId });

    wallet.balance = roundCurrency(wallet.balance + roundedAmount);
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletToppedUp", description: `Topped up ${roundedAmount} ${wallet.currency} via ${paymentMethod}.`, performedBy: userId || null });
    await wallet.save();

    const transaction = await WalletTransactionModel.create({
      tenantId, walletId: wallet._id, type: "TopUp", direction: "Credit", amount: roundedAmount, balanceAfter: wallet.balance,
      currency: wallet.currency, paymentId: payment._id, description: `Top-up via ${paymentMethod}`, performedBy: userId || null
    });

    const journal = await WalletService._postWalletJournal({
      tenantId, userId, description: `Wallet top-up ${wallet.walletNumber}`, currency: wallet.currency, referenceNumber: wallet.walletNumber,
      lines: [{ accountCode: getFinanceConfig().defaultCashAccountCode, debit: roundedAmount }, { accountCode: getFinanceConfig().walletLiabilityAccountCode, credit: roundedAmount }]
    });

    await AuditLogModel.create({ action: "finance.wallet.topup", module: "Finance", resource: "Wallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, paymentId: payment._id.toString(), journalId: journal?._id?.toString() || null } });
    publishEvent("WalletToppedUp", { tenantId, walletId: wallet._id.toString(), customerId: wallet.customerId.toString(), amount: roundedAmount, currency: wallet.currency, balance: wallet.balance, performedBy: userId || null });
    WalletService._publishBalanceUpdated(tenantId, wallet, userId);

    return { wallet: wallet.toJSON(), payment, transaction: transaction.toJSON() };
  }

  /**
   * POST /api/v1/wallets/{walletId}/purchase — spends the wallet's own
   * already-real balance against an existing Customer Collection, through
   * the real `CustomerCollectionService.collectPayment` flow (allocation,
   * receipt, ledger all reused, not reimplemented). Balance is verified
   * BEFORE calling collect and debited only AFTER it genuinely succeeds
   * (this codebase has no multi-document transactions — see
   * FinanceSequenceModel's own doc comment — so ordering is the safety
   * net, same discipline `AccountsReceivableService.allocatePayment`
   * already applies). Safe because "Wallet" always resolves to the
   * deterministic Manual gateway, which never externally fails.
   */
  static async purchase(walletId, data, tenantId, userId) {
    const { amount, collectionId, installmentNumber = null } = data;
    if (!amount || amount <= 0) throw new Error("amount must be greater than zero.");
    if (!collectionId) throw new Error("collectionId is required.");

    const wallet = await WalletService.getWalletById(walletId, tenantId);
    if (!isWalletUsable(wallet.status)) throw new Error(`Wallet is not usable (status "${wallet.status}").`);
    const roundedAmount = roundCurrency(amount);
    if (!hasSufficientBalance(wallet.balance, roundedAmount)) {
      throw new Error(`Insufficient wallet balance: requested ${roundedAmount}, available ${wallet.balance}.`);
    }

    const { default: CustomerCollectionService } = await import("./CustomerCollectionService.js");
    const collectResult = await CustomerCollectionService.collectPayment(collectionId, {
      amount: roundedAmount, paymentMethod: "Wallet", installmentNumber
    }, tenantId, userId);

    if (collectResult.paymentStatus === "Failed") {
      return { wallet: wallet.toJSON(), collection: collectResult, transaction: null };
    }

    wallet.balance = roundCurrency(wallet.balance - roundedAmount);
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletPurchase", description: `Spent ${roundedAmount} ${wallet.currency} on collection ${collectResult.collectionNumber || collectionId}.`, performedBy: userId || null });
    await wallet.save();

    const transaction = await WalletTransactionModel.create({
      tenantId, walletId: wallet._id, type: "Purchase", direction: "Debit", amount: roundedAmount, balanceAfter: wallet.balance,
      currency: wallet.currency, paymentId: collectResult.paymentId || null, collectionId, description: "Wallet purchase", performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.wallet.purchase", module: "Finance", resource: "Wallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, collectionId: collectionId.toString() } });
    publishEvent("WalletDebited", { tenantId, walletId: wallet._id.toString(), customerId: wallet.customerId.toString(), amount: roundedAmount, currency: wallet.currency, balance: wallet.balance, performedBy: userId || null });
    WalletService._publishBalanceUpdated(tenantId, wallet, userId);

    return { wallet: wallet.toJSON(), collection: collectResult, transaction: transaction.toJSON() };
  }

  /** POST /api/v1/wallets/{walletId}/refund — credits the wallet directly (e.g. a refund redirected to wallet credit rather than the original payment method). */
  static async refund(walletId, data, tenantId, userId) {
    const { amount, reason = null, paymentId = null } = data;
    if (!amount || amount <= 0) throw new Error("amount must be greater than zero.");

    const wallet = await WalletService.getWalletById(walletId, tenantId);
    const roundedAmount = roundCurrency(amount);

    wallet.balance = roundCurrency(wallet.balance + roundedAmount);
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletRefunded", description: `Refunded ${roundedAmount} ${wallet.currency}${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await wallet.save();

    const transaction = await WalletTransactionModel.create({
      tenantId, walletId: wallet._id, type: "Refund", direction: "Credit", amount: roundedAmount, balanceAfter: wallet.balance,
      currency: wallet.currency, paymentId, description: reason || "Wallet refund", performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.wallet.refund", module: "Finance", resource: "Wallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, reason } });
    publishEvent("WalletCredited", { tenantId, walletId: wallet._id.toString(), customerId: wallet.customerId.toString(), amount: roundedAmount, currency: wallet.currency, balance: wallet.balance, performedBy: userId || null });
    WalletService._publishBalanceUpdated(tenantId, wallet, userId);

    return { wallet: wallet.toJSON(), transaction: transaction.toJSON() };
  }

  /** POST /api/v1/wallets/{walletId}/transfer — a real internal move between two of this tenant's own wallets, in the same currency. */
  static async transfer(fromWalletId, data, tenantId, userId) {
    const { toWalletId, amount } = data;
    if (!toWalletId || !amount || amount <= 0) throw new Error("toWalletId and a positive amount are required.");
    if (fromWalletId.toString() === toWalletId.toString()) throw new Error("Cannot transfer a wallet to itself.");

    const fromWallet = await WalletService.getWalletById(fromWalletId, tenantId);
    const toWallet = await WalletService.getWalletById(toWalletId, tenantId);
    if (!isWalletUsable(fromWallet.status) || !isWalletUsable(toWallet.status)) throw new Error("Both wallets must be Active to transfer.");
    if (fromWallet.currency !== toWallet.currency) throw new Error(`Currency mismatch: ${fromWallet.currency} vs ${toWallet.currency}.`);

    const roundedAmount = roundCurrency(amount);
    if (!hasSufficientBalance(fromWallet.balance, roundedAmount)) {
      throw new Error(`Insufficient wallet balance: requested ${roundedAmount}, available ${fromWallet.balance}.`);
    }

    fromWallet.balance = roundCurrency(fromWallet.balance - roundedAmount);
    fromWallet.updatedBy = userId || null;
    fromWallet.timeline.push({ event: "WalletTransferOut", description: `Transferred ${roundedAmount} ${fromWallet.currency} to wallet ${toWallet.walletNumber}.`, performedBy: userId || null });
    await fromWallet.save();

    toWallet.balance = roundCurrency(toWallet.balance + roundedAmount);
    toWallet.updatedBy = userId || null;
    toWallet.timeline.push({ event: "WalletTransferIn", description: `Received ${roundedAmount} ${toWallet.currency} from wallet ${fromWallet.walletNumber}.`, performedBy: userId || null });
    await toWallet.save();

    const [outTx, inTx] = await Promise.all([
      WalletTransactionModel.create({ tenantId, walletId: fromWallet._id, type: "TransferOut", direction: "Debit", amount: roundedAmount, balanceAfter: fromWallet.balance, currency: fromWallet.currency, counterpartyWalletId: toWallet._id, performedBy: userId || null }),
      WalletTransactionModel.create({ tenantId, walletId: toWallet._id, type: "TransferIn", direction: "Credit", amount: roundedAmount, balanceAfter: toWallet.balance, currency: toWallet.currency, counterpartyWalletId: fromWallet._id, performedBy: userId || null })
    ]);

    await AuditLogModel.create({ action: "finance.wallet.transfer", module: "Finance", resource: "Wallet", resourceId: fromWallet._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, toWalletId: toWallet._id.toString() } });
    publishEvent("WalletTransferred", { tenantId, fromWalletId: fromWallet._id.toString(), toWalletId: toWallet._id.toString(), amount: roundedAmount, currency: fromWallet.currency, performedBy: userId || null });
    WalletService._publishBalanceUpdated(tenantId, fromWallet, userId);
    WalletService._publishBalanceUpdated(tenantId, toWallet, userId);

    return { fromWallet: fromWallet.toJSON(), toWallet: toWallet.toJSON(), outTransaction: outTx.toJSON(), inTransaction: inTx.toJSON() };
  }

  /**
   * POST /api/v1/wallets/{walletId}/withdraw — "Withdrawal (Optional)."
   * Real balance debit and immutable ledger entry; no real external
   * payout/bank-transfer API integration exists in this codebase (same
   * honestly-deferred boundary as every other Part's excluded external
   * integrations) — this records that the funds left the wallet, not that
   * a bank transfer was actually wired.
   */
  static async withdraw(walletId, data, tenantId, userId) {
    const { amount, reason = null } = data;
    if (!amount || amount <= 0) throw new Error("amount must be greater than zero.");

    const wallet = await WalletService.getWalletById(walletId, tenantId);
    if (!isWalletUsable(wallet.status)) throw new Error(`Wallet is not usable (status "${wallet.status}").`);
    const roundedAmount = roundCurrency(amount);
    if (!hasSufficientBalance(wallet.balance, roundedAmount)) {
      throw new Error(`Insufficient wallet balance: requested ${roundedAmount}, available ${wallet.balance}.`);
    }

    wallet.balance = roundCurrency(wallet.balance - roundedAmount);
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletWithdrawn", description: `Withdrew ${roundedAmount} ${wallet.currency}${reason ? `: ${reason}` : ""}.`, performedBy: userId || null });
    await wallet.save();

    const transaction = await WalletTransactionModel.create({
      tenantId, walletId: wallet._id, type: "Withdrawal", direction: "Debit", amount: roundedAmount, balanceAfter: wallet.balance,
      currency: wallet.currency, description: reason || "Wallet withdrawal", performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.wallet.withdraw", module: "Finance", resource: "Wallet", resourceId: wallet._id.toString(), userId: userId || null, tenantId, details: { amount: roundedAmount, reason } });
    publishEvent("WalletDebited", { tenantId, walletId: wallet._id.toString(), customerId: wallet.customerId.toString(), amount: roundedAmount, currency: wallet.currency, balance: wallet.balance, performedBy: userId || null });
    WalletService._publishBalanceUpdated(tenantId, wallet, userId);

    return { wallet: wallet.toJSON(), transaction: transaction.toJSON() };
  }

  static async suspend(walletId, data, tenantId, userId) {
    const wallet = await WalletService.getWalletById(walletId, tenantId);
    wallet.status = "Suspended";
    wallet.suspendedReason = data?.reason || null;
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletSuspended", description: data?.reason || "Wallet suspended.", performedBy: userId || null });
    await wallet.save();
    return wallet.toJSON();
  }

  static async reactivate(walletId, tenantId, userId) {
    const wallet = await WalletService.getWalletById(walletId, tenantId);
    if (wallet.status !== "Suspended") throw new Error(`Only a Suspended wallet can be reactivated (status "${wallet.status}").`);
    wallet.status = "Active";
    wallet.suspendedReason = null;
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletReactivated", description: "Wallet reactivated.", performedBy: userId || null });
    await wallet.save();
    return wallet.toJSON();
  }

  static async close(walletId, tenantId, userId) {
    const wallet = await WalletService.getWalletById(walletId, tenantId);
    if (wallet.balance > 0) throw new Error(`Cannot close a wallet with a positive balance (${wallet.balance}) — withdraw or refund it out first.`);
    wallet.status = "Closed";
    wallet.closedAt = new Date();
    wallet.updatedBy = userId || null;
    wallet.timeline.push({ event: "WalletClosed", description: "Wallet closed.", performedBy: userId || null });
    await wallet.save();
    return wallet.toJSON();
  }
}

export default WalletService;
