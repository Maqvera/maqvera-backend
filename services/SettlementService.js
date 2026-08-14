import SettlementModel from "../models/SettlementModel.js";
import SettlementBatchModel from "../models/SettlementBatchModel.js";
import SettlementAdjustmentModel from "../models/SettlementAdjustmentModel.js";
import PaymentModel from "../models/PaymentModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import BankTransactionModel from "../models/BankTransactionModel.js";
import ChargebackModel from "../models/ChargebackModel.js";
import PaymentService, { isPaymentSettleable } from "./PaymentService.js";
import BankAccountService from "./BankAccountService.js";
import VendorCreditService from "./VendorCreditService.js";
import CurrencyService from "./CurrencyService.js";
import JournalService from "./JournalService.js";
import { computeMatchScore } from "./BankReconciliationService.js";
import getPaymentFileGenerator from "./paymentFileGenerators/index.js";
import { getGatewayAdapter } from "./gateways/index.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/settlementService.test.js).
// ---------------------------------------------------------------------------

const ADJUSTMENT_BLOCKED_STATUSES = new Set(["Failed", "Reversed", "Cancelled"]);
export const isSettlementCancellable = (status) => status === "Pending";
export const isSettlementReversible = (status) => status === "Completed";
// A settlement can be adjusted (corrected, charged back, manually
// compensated) in any state except the three genuine dead ends — even a
// Completed settlement, since a chargeback or correction can arrive
// after real money has already moved.
export const isSettlementAdjustable = (status) => !ADJUSTMENT_BLOCKED_STATUSES.has(status);
export const isSettlementCompletable = (status) => ["Sent", "Processing"].includes(status);

/**
 * "Settlement Fees... Gateway Fee, Bank Fee, Commission, Tax, FX Fee,
 * Processing Fee. Configurable." Real percentage+fixed math against the
 * tenant's own `settlementFeeSchedule`, keyed by gateway with a
 * `Default` fallback for any gateway not explicitly configured.
 */
export const computeSettlementFees = (grossAmount, gateway, feeSchedule) => {
  const schedule = feeSchedule[gateway] || feeSchedule.Default || {};
  const fees = [];
  for (const [feeType, rule] of Object.entries(schedule)) {
    const amount = roundCurrency(grossAmount * ((rule.percent || 0) / 100) + (rule.fixed || 0));
    if (amount > 0) fees.push({ feeType, amount });
  }
  const feeTotal = roundCurrency(fees.reduce((sum, f) => sum + f.amount, 0));
  return { fees, feeTotal };
};

/** "Net Settlement: Gross Amount -> Less Fees -> Less Tax -> FX Adjustment -> Net Amount." fxAdjustment may be positive or negative depending on conversion direction. */
export const computeNetAmount = (grossAmount, feeTotal, fxAdjustment = 0) => roundCurrency(grossAmount - feeTotal + fxAdjustment);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SettlementService {
  static async _generateCode(tenantId, scope, prefix) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, scope, year);
    return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  static async _postAutomaticJournal({ tenantId, userId, postingDate, description, currency, referenceNumber, lines }) {
    const journal = await JournalService.createJournal({ journalType: "Automatic", postingDate, description, referenceNumber, currency, lines }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    return JournalService.postJournal(journal._id, tenantId, userId || "system");
  }

  // ---- Settlements ----

  /**
   * POST /api/v1/settlements
   * Validate Payment -> Validate Settlement Account -> Calculate Fees ->
   * Create Settlement -> Publish SettlementCreated. "Payment Completed,"
   * "Currency Match" (or a resolvable FX conversion), "Settlement
   * Account Active" — real checks, not assumed.
   */
  static async createSettlement(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentId, settlementAccount: settlementAccountId, settlementDate, splits = [] } = data;
    if (!paymentId || !settlementAccountId || !settlementDate) throw new Error("paymentId, settlementAccount, and settlementDate are required.");

    const payment = await PaymentModel.findOne({ _id: paymentId, tenantId }).lean();
    if (!payment) throw new Error("Payment not found.");
    if (!isPaymentSettleable(payment.status)) throw new Error(`Payment is not ready to settle (status: "${payment.status}"). A payment must be Captured or Allocated.`);

    const existing = await SettlementModel.findOne({ tenantId, paymentId, status: { $nin: ["Failed", "Cancelled"] } }).lean();
    if (existing) throw new Error(`Payment ${paymentId} is already being settled (settlement ${existing.settlementNumber}).`);

    const settlementAccount = await BankAccountModel.findOne({ _id: settlementAccountId, tenantId }).lean();
    if (!settlementAccount) throw new Error("Settlement account not found.");
    if (settlementAccount.status !== "Active") throw new Error(`Settlement account is not Active (status: "${settlementAccount.status}").`);

    const grossAmount = roundCurrency(payment.amount);
    const { fees, feeTotal } = computeSettlementFees(grossAmount, payment.gateway, config.settlementFeeSchedule);

    let fxAdjustment = 0;
    let netCurrency = payment.currency;
    if (settlementAccount.currency !== payment.currency) {
      const converted = await CurrencyService.convert(roundCurrency(grossAmount - feeTotal), payment.currency, settlementAccount.currency, tenantId, { asOfDate: new Date(settlementDate) });
      fxAdjustment = roundCurrency(converted.convertedAmount - roundCurrency(grossAmount - feeTotal));
      netCurrency = settlementAccount.currency;
    }

    const netAmount = computeNetAmount(grossAmount, feeTotal, fxAdjustment);
    if (netAmount <= 0) throw new Error(`Net settlement amount must be positive (computed ${netAmount}).`);

    const settlementNumber = await SettlementService._generateCode(tenantId, "settlementNumber", config.settlementNumberPrefix);

    const settlement = new SettlementModel({
      tenantId, settlementNumber, paymentId, settlementAccountId, gateway: payment.gateway, grossAmount, fees, feeTotal,
      fxAdjustment, netAmount, currency: netCurrency, settlementDate: new Date(settlementDate), status: config.defaultSettlementStatus,
      timeline: [{ event: "SettlementCreated", description: `Settlement ${settlementNumber} created for payment ${payment.paymentNumber} — gross ${grossAmount} ${payment.currency}, net ${netAmount} ${netCurrency}.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (Array.isArray(splits) && splits.length > 0) {
      await SettlementService._applySplits(settlement, splits, netAmount, tenantId, userId);
    }

    await settlement.save();

    await AuditLogModel.create({ action: "finance.settlement.create", module: "Finance", resource: "Settlement", resourceId: settlement._id.toString(), userId: userId || null, tenantId, details: { settlementNumber, grossAmount, netAmount } });
    publishEvent("SettlementCreated", { tenantId, settlementId: settlement._id.toString(), paymentId: paymentId.toString(), grossAmount, netAmount, currency: netCurrency, performedBy: userId || null });
    publishEvent("SettlementValidated", { tenantId, settlementId: settlement._id.toString(), performedBy: userId || null });

    return settlement.toJSON();
  }

  /**
   * "Split Settlements... Marketplace, Commission, Partner Share, Vendor
   * Share, Platform Fee. Automatic allocation." A VendorShare/PartnerShare
   * split naming a real vendor `payeeId` is actually paid out via the
   * real, already-shipped `VendorCreditService.createCredit` (Part 17's
   * own reuse pattern) — never a parallel payout mechanism. A
   * Marketplace/PlatformFee/Commission split with no `payeeId` is simply
   * recorded (a retained platform amount), not paid out anywhere.
   */
  static async _applySplits(settlement, splits, netAmount, tenantId, userId) {
    const config = getFinanceConfig();
    const splitTotal = roundCurrency(splits.reduce((sum, s) => sum + Number(s.amount || 0), 0));
    if (splitTotal > netAmount) throw new Error(`Split total (${splitTotal}) cannot exceed the settlement's own net amount (${netAmount}).`);

    for (const split of splits) {
      if (!config.settlementSplitTypes.includes(split.splitType)) throw new Error(`Invalid splitType "${split.splitType}".`);
      const resolvedSplit = { splitType: split.splitType, payeeType: split.payeeType || null, payeeId: split.payeeId || null, amount: roundCurrency(split.amount), vendorCreditId: null };

      if (["VendorShare", "PartnerShare"].includes(split.splitType) && split.payeeType === "vendor" && split.payeeId) {
        const credit = await VendorCreditService.createCredit({ vendorId: split.payeeId, amount: resolvedSplit.amount, currency: settlement.currency, source: split.splitType, sourceReferenceId: settlement._id }, tenantId, userId);
        resolvedSplit.vendorCreditId = credit._id;
      }

      settlement.splits.push(resolvedSplit);
    }
  }

  static async listSettlements(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.batchId) filter.batchId = query.batchId;
    if (query.gateway) filter.gateway = query.gateway;
    if (query.currency) filter.currency = query.currency.toUpperCase();
    if (query.dateFrom || query.dateTo) {
      filter.settlementDate = {};
      if (query.dateFrom) filter.settlementDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.settlementDate.$lte = new Date(query.dateTo);
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { settlementDate: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      const field = query.sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      SettlementModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      SettlementModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getSettlementById(settlementId, tenantId) {
    const settlement = await SettlementModel.findOne({ _id: settlementId, tenantId }).lean();
    if (!settlement) throw new Error("Settlement not found.");
    const adjustments = await SettlementAdjustmentModel.find({ tenantId, settlementId: settlement._id }).sort({ createdAt: -1 }).lean();
    return { ...settlement, adjustments };
  }

  static async cancelSettlement(settlementId, data, tenantId, userId) {
    const settlement = await SettlementModel.findOne({ _id: settlementId, tenantId });
    if (!settlement) throw new Error("Settlement not found.");
    if (!isSettlementCancellable(settlement.status)) throw new Error(`Settlement cannot be cancelled from status "${settlement.status}".`);

    settlement.status = "Cancelled";
    settlement.updatedBy = userId || null;
    settlement.timeline.push({ event: "SettlementCancelled", description: data?.reason || "Settlement cancelled.", performedBy: userId || null });
    await settlement.save();

    await AuditLogModel.create({ action: "finance.settlement.cancel", module: "Finance", resource: "Settlement", resourceId: settlement._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return settlement.toJSON();
  }

  // ---- Batches ----

  /** POST /api/v1/settlement-batches — groups Pending settlements (same currency + settlement account) for one real bank file. */
  static async createBatch(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { batchType, settlementIds, scheduledDate = null } = data;
    if (!config.settlementBatchTypes.includes(batchType)) throw new Error(`Invalid batchType "${batchType}".`);
    if (!Array.isArray(settlementIds) || settlementIds.length === 0) throw new Error("settlementIds must be a non-empty array.");

    const settlements = await SettlementModel.find({ _id: { $in: settlementIds }, tenantId, status: "Pending" }).lean();
    if (settlements.length !== settlementIds.length) throw new Error("One or more settlements were not found, or are not in Pending status.");
    const currencies = new Set(settlements.map((s) => s.currency));
    const accounts = new Set(settlements.map((s) => s.settlementAccountId.toString()));
    if (currencies.size > 1) throw new Error("All settlements in one batch must share the same currency.");
    if (accounts.size > 1) throw new Error("All settlements in one batch must share the same settlement account.");

    const totalGrossAmount = roundCurrency(settlements.reduce((sum, s) => sum + s.grossAmount, 0));
    const totalFees = roundCurrency(settlements.reduce((sum, s) => sum + s.feeTotal, 0));
    const totalNetAmount = roundCurrency(settlements.reduce((sum, s) => sum + s.netAmount, 0));
    const batchNumber = await SettlementService._generateCode(tenantId, "settlementBatchNumber", config.settlementBatchNumberPrefix);

    const batch = await SettlementBatchModel.create({
      tenantId, batchNumber, batchType, settlementAccountId: settlements[0].settlementAccountId, currency: settlements[0].currency,
      settlementIds, totalGrossAmount, totalFees, totalNetAmount, status: "Open", scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      timeline: [{ event: "SettlementBatchCreated", description: `${batchType} batch of ${settlements.length} settlement(s) totaling ${totalNetAmount} ${settlements[0].currency}.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await SettlementModel.updateMany({ _id: { $in: settlementIds }, tenantId }, { $set: { batchId: batch._id } });

    await AuditLogModel.create({ action: "finance.settlement.create_batch", module: "Finance", resource: "SettlementBatch", resourceId: batch._id.toString(), userId: userId || null, tenantId, details: { batchNumber, batchType, totalNetAmount, count: settlements.length } });
    publishEvent("SettlementBatchCreated", { tenantId, batchId: batch._id.toString(), batchType, totalNetAmount, count: settlements.length, performedBy: userId || null });

    return batch.toJSON();
  }

  static async listBatches(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.batchType) filter.batchType = query.batchType;
    return SettlementBatchModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getBatchById(batchId, tenantId) {
    const batch = await SettlementBatchModel.findOne({ _id: batchId, tenantId }).lean();
    if (!batch) throw new Error("Settlement batch not found.");
    return batch;
  }

  /**
   * POST /api/v1/settlement-batches/{batchId}/send — "Sent To Bank." A
   * real remittance/settlement-advice file, reusing
   * `services/paymentFileGenerators/` directly (the exact real CSV/ACH/
   * SEPA/SWIFT generation Part 17 already built for vendor payments) —
   * here framed as the settlement account's own bank being told what net
   * amounts to expect from the gateway, not a parallel implementation.
   */
  static async sendBatch(batchId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { format } = data;
    if (!getPaymentFileGenerator(format)) throw new Error(`Payment file format "${format}" is not supported — no generator is implemented for it.`);

    const batch = await SettlementBatchModel.findOne({ _id: batchId, tenantId });
    if (!batch) throw new Error("Settlement batch not found.");
    if (batch.status !== "Open") throw new Error(`Batch cannot be sent from status "${batch.status}".`);

    const settlementAccount = await BankAccountModel.findOne({ _id: batch.settlementAccountId, tenantId }).lean();
    if (!settlementAccount) throw new Error("Settlement account not found.");
    const settlements = await SettlementModel.find({ _id: { $in: batch.settlementIds }, tenantId }).lean();

    const generator = getPaymentFileGenerator(format);
    const batchData = {
      batchNumber: batch.batchNumber, paymentDate: new Date(), currency: batch.currency,
      originator: { name: settlementAccount.accountName, taxId: settlementAccount.bankAccountCode, routingNumber: settlementAccount.routingNumber, accountNumber: settlementAccount.accountNumberLast4, iban: settlementAccount.iban, swiftBic: settlementAccount.swiftCode, bankName: settlementAccount.bankName },
      payments: settlements.map((s) => ({ vendorName: `Settlement ${s.settlementNumber}`, vendorTaxId: null, amount: s.netAmount, reference: s.settlementNumber, bankAccount: {} }))
    };
    const result = generator.generate(batchData);
    const stored = await storeDocumentPdf({ tenantId, folder: "settlement-files", filename: result.filename, buffer: Buffer.from(result.content, "utf8") });

    batch.status = "Sent";
    batch.sentAt = new Date();
    batch.fileGeneration = { format, generatedAt: new Date(), url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider };
    batch.updatedBy = userId || null;
    batch.timeline.push({ event: "SettlementSent", description: `Sent as ${format}.`, performedBy: userId || null });
    await batch.save();

    await SettlementModel.updateMany({ _id: { $in: batch.settlementIds }, tenantId }, { $set: { status: "Sent" }, $push: { timeline: { event: "SettlementSent", description: `Sent via batch ${batch.batchNumber}.`, performedBy: userId || null, performedAt: new Date() } } });

    await AuditLogModel.create({ action: "finance.settlement.send_batch", module: "Finance", resource: "SettlementBatch", resourceId: batch._id.toString(), userId: userId || null, tenantId, details: { format } });
    publishEvent("SettlementSent", { tenantId, batchId: batch._id.toString(), format, count: settlements.length, performedBy: userId || null });

    return batch.toJSON();
  }

  /**
   * POST /api/v1/settlements/{settlementId}/complete — the real
   * conclusion of the whole Part: credits the settlement account
   * (`BankAccountService.applyTransaction`, Part 13), posts a real fee
   * journal when configured, and finally gives `PaymentModel`'s own long-
   * listed `'Settled'` status its first real setter
   * (`PaymentService.markSettled`).
   */
  static async completeSettlement(settlementId, tenantId, userId) {
    const config = getFinanceConfig();
    const settlement = await SettlementModel.findOne({ _id: settlementId, tenantId });
    if (!settlement) throw new Error("Settlement not found.");
    if (!isSettlementCompletable(settlement.status)) throw new Error(`Settlement cannot be completed from status "${settlement.status}".`);

    settlement.status = "Processing";
    await settlement.save();

    try {
      const { transaction } = await BankAccountService.applyTransaction(settlement.settlementAccountId, tenantId, {
        direction: "Credit", amount: settlement.netAmount, currency: settlement.currency, type: "Settlement",
        sourceType: "Settlement", sourceId: settlement._id, description: `Settlement ${settlement.settlementNumber}`, performedBy: userId || null
      });

      let journalId = null;
      if (settlement.feeTotal > 0 && config.settlementFeeExpenseAccountCode && config.settlementClearingAccountCode) {
        const journal = await SettlementService._postAutomaticJournal({
          tenantId, userId, postingDate: new Date(), description: `Settlement fees for ${settlement.settlementNumber}`, currency: settlement.currency, referenceNumber: settlement.settlementNumber,
          lines: [{ accountCode: config.settlementFeeExpenseAccountCode, debit: settlement.feeTotal }, { accountCode: config.settlementClearingAccountCode, credit: settlement.feeTotal }]
        });
        journalId = journal?._id || null;
      }

      settlement.status = "Completed";
      settlement.journalId = journalId;
      settlement.updatedBy = userId || null;
      settlement.timeline.push({ event: "SettlementCompleted", description: `Completed — ${settlement.netAmount} ${settlement.currency} credited to settlement account (bank transaction ${transaction.transactionNumber}).`, performedBy: userId || null });
      await settlement.save();

      await PaymentService.markSettled(settlement.paymentId, tenantId, { settlementId: settlement._id, userId });

      await AuditLogModel.create({ action: "finance.settlement.complete", module: "Finance", resource: "Settlement", resourceId: settlement._id.toString(), userId: userId || null, tenantId, details: { netAmount: settlement.netAmount, journalId } });
      publishEvent("SettlementCompleted", { tenantId, settlementId: settlement._id.toString(), paymentId: settlement.paymentId.toString(), netAmount: settlement.netAmount, currency: settlement.currency, performedBy: userId || null });
    } catch (error) {
      settlement.status = "Failed";
      settlement.failureReason = error.message;
      settlement.timeline.push({ event: "SettlementFailed", description: error.message, performedBy: userId || null });
      await settlement.save();
      publishEvent("SettlementFailed", { tenantId, settlementId: settlement._id.toString(), reason: error.message, performedBy: userId || null });
    }

    return settlement.toJSON();
  }

  static async completeBatch(batchId, tenantId, userId) {
    const batch = await SettlementBatchModel.findOne({ _id: batchId, tenantId });
    if (!batch) throw new Error("Settlement batch not found.");
    if (batch.status !== "Sent") throw new Error(`Batch cannot be completed from status "${batch.status}".`);

    let failedCount = 0;
    for (const settlementId of batch.settlementIds) {
      const result = await SettlementService.completeSettlement(settlementId, tenantId, userId);
      if (result.status === "Failed") failedCount += 1;
    }

    batch.status = failedCount > 0 ? "PartiallyFailed" : "Completed";
    batch.completedAt = new Date();
    batch.updatedBy = userId || null;
    batch.timeline.push({ event: "SettlementBatchCompleted", description: `Completed ${batch.settlementIds.length} settlement(s), ${failedCount} failed.`, performedBy: userId || null });
    await batch.save();

    await AuditLogModel.create({ action: "finance.settlement.complete_batch", module: "Finance", resource: "SettlementBatch", resourceId: batch._id.toString(), userId: userId || null, tenantId, details: { failedCount } });

    return batch.toJSON();
  }

  // ---- Adjustments ----

  /**
   * POST /api/v1/settlements/{settlementId}/adjustments — "Corrections,
   * Reversals, Chargebacks, Manual Adjustments, Compensation Entries.
   * Auditable." `Chargeback` requires an existing, real Part 12
   * `ChargebackModel` row for the same payment — never a reimplemented
   * dispute record.
   */
  static async createAdjustment(settlementId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { adjustmentType, amount, reason = null, chargebackId = null } = data;
    if (!config.settlementAdjustmentTypes.includes(adjustmentType)) throw new Error(`Invalid adjustmentType "${adjustmentType}".`);
    if (amount === undefined || amount === null || amount === 0) throw new Error("A non-zero amount is required.");

    const settlement = await SettlementModel.findOne({ _id: settlementId, tenantId });
    if (!settlement) throw new Error("Settlement not found.");
    if (!isSettlementAdjustable(settlement.status)) throw new Error(`Settlement cannot be adjusted from status "${settlement.status}".`);

    if (adjustmentType === "Chargeback") {
      if (!chargebackId) throw new Error("chargebackId is required for a Chargeback adjustment.");
      const chargeback = await ChargebackModel.findOne({ _id: chargebackId, tenantId, paymentId: settlement.paymentId }).lean();
      if (!chargeback) throw new Error("Chargeback not found for this settlement's own payment.");
    }

    const roundedAmount = roundCurrency(amount);
    const adjustment = await SettlementAdjustmentModel.create({ tenantId, settlementId: settlement._id, adjustmentType, amount: roundedAmount, reason, chargebackId, performedBy: userId || null });

    settlement.netAmount = roundCurrency(settlement.netAmount + roundedAmount);
    if (adjustmentType === "Chargeback" || (adjustmentType === "Reversal" && roundedAmount < 0)) settlement.status = "Disputed";
    settlement.updatedBy = userId || null;
    settlement.timeline.push({ event: "SettlementAdjusted", description: `${adjustmentType}: ${roundedAmount} ${settlement.currency}${reason ? ` — ${reason}` : ""}.`, performedBy: userId || null });
    await settlement.save();

    await AuditLogModel.create({ action: "finance.settlement.adjust", module: "Finance", resource: "Settlement", resourceId: settlement._id.toString(), userId: userId || null, tenantId, details: { adjustmentType, amount: roundedAmount } });
    if (adjustmentType === "Reversal") publishEvent("SettlementReversed", { tenantId, settlementId: settlement._id.toString(), amount: roundedAmount, performedBy: userId || null });

    return { settlement: settlement.toJSON(), adjustment: adjustment.toJSON() };
  }

  // ---- Reconciliation ----

  /**
   * POST /api/v1/settlements/reconcile — "Gateway Reports, Bank
   * Statements, Merchant Reports, Internal Ledger, Exception Detection,
   * Automatic matching." Reuses Part 14's own real fuzzy-matching engine
   * (`computeMatchScore`) directly against real `BankTransactionModel`
   * entries for the settlement account — one matching engine for the
   * whole ERP, not a parallel implementation.
   */
  static async reconcileSettlements(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { settlementAccountId, dateFrom = null, dateTo = null } = data;
    if (!settlementAccountId) throw new Error("settlementAccountId is required.");

    const filter = { tenantId, settlementAccountId, status: { $in: ["Sent", "Processing", "Completed"] }, "reconciliation.matched": false };
    if (dateFrom || dateTo) {
      filter.settlementDate = {};
      if (dateFrom) filter.settlementDate.$gte = new Date(dateFrom);
      if (dateTo) filter.settlementDate.$lte = new Date(dateTo);
    }
    const settlements = await SettlementModel.find(filter);
    const bankTransactions = await BankTransactionModel.find({ tenantId, bankAccountId: settlementAccountId, direction: "Credit" }).lean();

    let matchedCount = 0;
    for (const settlement of settlements) {
      const erpTxn = { direction: "Credit", currency: settlement.currency, amount: settlement.netAmount, date: settlement.settlementDate, description: settlement.settlementNumber };
      let best = null;
      for (const bankTxn of bankTransactions) {
        const statementTxn = { direction: bankTxn.direction, currency: bankTxn.currency, amount: bankTxn.amount, transactionDate: bankTxn.createdAt, reference: bankTxn.description };
        const { score, eligible } = computeMatchScore({ statementTxn, erpTxn, config });
        if (eligible && score >= 70 && (!best || score > best.score)) best = { score, bankTxn };
      }
      if (best) {
        settlement.reconciliation = { matched: true, matchedBankTransactionId: best.bankTxn._id, matchScore: best.score, matchedAt: new Date() };
        settlement.timeline.push({ event: "SettlementReconciled", description: `Matched bank transaction ${best.bankTxn.transactionNumber} (score ${best.score}).`, performedBy: userId || "system" });
        await settlement.save();
        matchedCount += 1;
        publishEvent("SettlementReconciled", { tenantId, settlementId: settlement._id.toString(), bankTransactionId: best.bankTxn._id.toString(), score: best.score, performedBy: userId || "system" });
        // "PaymentReconciled" (Part 18 Part 5) — the payment-level view of
        // the same real match; SettlementReconciled is the settlement-
        // level record of it.
        publishEvent("PaymentReconciled", { tenantId, paymentId: settlement.paymentId.toString(), settlementId: settlement._id.toString(), bankTransactionId: best.bankTxn._id.toString(), performedBy: userId || "system" });
      }
    }

    await AuditLogModel.create({ action: "finance.settlement.reconcile", module: "Finance", resource: "Settlement", resourceId: settlementAccountId.toString(), userId: userId || null, tenantId, details: { checked: settlements.length, matched: matchedCount } });

    return { checked: settlements.length, matched: matchedCount, unmatched: settlements.length - matchedCount };
  }

  /**
   * GET /api/v1/settlements/gateway-report — "Gateway Reports." Real,
   * when the gateway implements it (Stripe Payouts API); a gateway with
   * no real report source (Manual) returns an empty, honest result.
   */
  static async fetchGatewaySettlementReport(gateway, params) {
    const adapter = getGatewayAdapter(gateway);
    if (!adapter) throw new Error(`Gateway "${gateway}" is not supported.`);
    return adapter.fetchSettlementReport(params);
  }
}

export default SettlementService;
