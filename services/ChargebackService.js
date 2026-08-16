import ChargebackModel from "../models/ChargebackModel.js";
import PaymentModel from "../models/PaymentModel.js";
import JournalService from "./JournalService.js";
import FinancialPeriodService from "./FinancialPeriodService.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

const RESOLVABLE_STATUSES = new Set(["Open", "Evidence Submitted", "Under Appeal"]);

/** Pure predicate — testable without a DB. */
export const isChargebackResolvable = (status) => RESOLVABLE_STATUSES.has(status);

/**
 * "Appeals" (spec bullet) is represented by resubmitting evidence while
 * already "Evidence Submitted" (-> "Under Appeal"); further evidence while
 * already "Under Appeal" stays "Under Appeal" — not a separate state
 * machine — see ChargebackService.submitEvidence.
 */
export const nextStatusAfterEvidence = (currentStatus) => (currentStatus === "Open" ? "Evidence Submitted" : "Under Appeal");

class ChargebackService {
  static async _generateChargebackNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "chargebackNumber", year);
    return `${config.chargebackNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /**
   * POST /api/v1/refunds/chargebacks — gap-fill. Records a real, already-
   * happened bank/card-network event, not a request awaiting our approval —
   * unlike Refund, there is no "Requested -> Approved" gate: the money was
   * already pulled back by the time this is filed, so `payment.status`
   * flips to "Chargeback" immediately (Part 7's own paymentStatuses already
   * names this value with no endpoint to reach it until now).
   */
  static async createChargeback(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { paymentId, amount, reason, gatewayDisputeId = null, refundId = null } = data;

    if (!paymentId || !amount || amount <= 0 || !reason) {
      throw new Error("paymentId, a positive amount, and reason are required.");
    }

    const payment = await PaymentModel.findOne({ _id: paymentId, tenantId });
    if (!payment) throw new Error("Payment not found.");

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount > payment.amount) {
      throw new Error(`Chargeback amount ${roundedAmount} exceeds the original payment amount (${payment.amount}).`);
    }

    const chargebackNumber = await ChargebackService._generateChargebackNumber(tenantId);

    const chargeback = await ChargebackModel.create({
      tenantId,
      chargebackNumber,
      paymentId: payment._id,
      paymentNumber: payment.paymentNumber,
      refundId,
      amount: roundedAmount,
      currency: payment.currency,
      reason,
      gatewayDisputeId,
      status: config.defaultChargebackStatus,
      timeline: [{ event: "ChargebackCreated", description: `Chargeback of ${roundedAmount} ${payment.currency} filed against payment ${payment.paymentNumber}.`, performedBy: userId || null }],
      createdBy: userId || null,
      updatedBy: userId || null
    });

    payment.status = "Chargeback";
    payment.timeline.push({ event: "PaymentChargedBack", description: `Chargeback ${chargebackNumber} filed for ${roundedAmount} ${payment.currency}.`, performedBy: userId || null });
    await payment.save();

    await AuditLogModel.create({ action: "finance.chargeback.create", module: "Finance", resource: "Chargeback", resourceId: chargeback._id.toString(), userId: userId || null, tenantId, details: { chargebackNumber, paymentId: paymentId.toString(), amount: roundedAmount } });
    publishEvent("ChargebackCreated", { tenantId, chargebackId: chargeback._id.toString(), paymentId: paymentId.toString(), amount: roundedAmount, performedBy: userId || null });

    return chargeback.toJSON();
  }

  static async listChargebacks(query, tenantId) {
    const config = getFinanceConfig();
    const { paymentId, status, currency } = query;
    const filter = { tenantId };
    if (paymentId) filter.paymentId = paymentId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

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
      ChargebackModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      ChargebackModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getChargebackById(chargebackId, tenantId) {
    const chargeback = await ChargebackModel.findOne({ _id: chargebackId, tenantId }).lean();
    if (!chargeback) throw new Error("Chargeback not found.");

    const auditSummary = await AuditLogModel.find({ tenantId, resource: "Chargeback", resourceId: chargeback._id.toString() }).sort({ createdAt: -1 }).limit(20).lean();
    return { ...chargeback, auditSummary };
  }

  /**
   * POST /api/v1/refunds/chargebacks/{chargebackId}/evidence — gap-fill.
   * "Evidence Upload" reuses this codebase's existing generic document
   * storage abstraction — callers supply URLs already obtained via the
   * existing upload path, this endpoint does not implement a parallel one.
   * No dedicated domain event is named for this transition — none invented.
   */
  static async submitEvidence(chargebackId, data, tenantId, userId) {
    const { evidenceUrls } = data;
    if (!Array.isArray(evidenceUrls) || evidenceUrls.length === 0) {
      throw new Error("evidenceUrls must be a non-empty array.");
    }

    const chargeback = await ChargebackModel.findOne({ _id: chargebackId, tenantId });
    if (!chargeback) throw new Error("Chargeback not found.");
    if (!isChargebackResolvable(chargeback.status)) throw new Error(`Chargeback cannot accept evidence from status "${chargeback.status}".`);

    const nextStatus = nextStatusAfterEvidence(chargeback.status);
    chargeback.evidenceUrls.push(...evidenceUrls);
    chargeback.status = nextStatus;
    chargeback.updatedBy = userId || null;
    chargeback.timeline.push({ event: "ChargebackEvidenceSubmitted", description: `${evidenceUrls.length} evidence file(s) submitted.`, performedBy: userId || null });
    await chargeback.save();

    await AuditLogModel.create({ action: "finance.chargeback.submit_evidence", module: "Finance", resource: "Chargeback", resourceId: chargeback._id.toString(), userId: userId || null, tenantId, details: { evidenceCount: evidenceUrls.length } });

    return chargeback.toJSON();
  }

  /**
   * POST /api/v1/refunds/chargebacks/{chargebackId}/resolve — "Final
   * Decision." `decision: "Won"` reverses the dispute: the bank restored
   * the funds, so `payment.status` reverts to "Captured" — no journal is
   * posted, mirroring that none was posted when the dispute opened either
   * (this codebase only recognizes the gain/loss once a dispute is FINAL,
   * not while pending). `decision: "Lost"` posts a real loss journal and
   * leaves `payment.status` at "Chargeback" (terminal).
   */
  static async resolveChargeback(chargebackId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const { decision } = data;
    if (!["Won", "Lost"].includes(decision)) throw new Error('decision must be "Won" or "Lost".');

    const chargeback = await ChargebackModel.findOne({ _id: chargebackId, tenantId });
    if (!chargeback) throw new Error("Chargeback not found.");
    if (!isChargebackResolvable(chargeback.status)) throw new Error(`Chargeback cannot be resolved from status "${chargeback.status}".`);

    let journalId = null;
    if (decision === "Lost") {
      await FinancialPeriodService.assertPeriodOpen(tenantId, new Date());
      const lossAccountCode = config.chargebackLossExpenseAccountCode || config.defaultRevenueAccountCode;
      if (lossAccountCode && config.defaultCashAccountCode) {
        const journal = await JournalService.createJournal({
          journalType: "Automatic",
          postingDate: new Date(),
          description: `Chargeback ${chargeback.chargebackNumber} lost`,
          referenceNumber: chargeback.chargebackNumber,
          currency: chargeback.currency,
          lines: [
            { accountCode: lossAccountCode, debit: chargeback.amount },
            { accountCode: config.defaultCashAccountCode, credit: chargeback.amount }
          ]
        }, tenantId, userId || "system");
        await JournalService.approveJournal(journal._id, tenantId, userId || "system");
        const posted = await JournalService.postJournal(journal._id, tenantId, userId || "system");
        journalId = posted?._id || journal._id;
      }
    } else {
      const payment = await PaymentModel.findOne({ _id: chargeback.paymentId, tenantId });
      if (payment && payment.status === "Chargeback") {
        payment.status = "Captured";
        payment.timeline.push({ event: "ChargebackWon", description: `Chargeback ${chargeback.chargebackNumber} resolved in our favor — funds restored.`, performedBy: userId || null });
        await payment.save();
      }
    }

    chargeback.status = decision;
    chargeback.finalDecision = decision;
    chargeback.resolvedBy = userId || null;
    chargeback.resolvedAt = new Date();
    chargeback.journalId = journalId;
    chargeback.updatedBy = userId || null;
    chargeback.timeline.push({ event: "ChargebackResolved", description: `Chargeback resolved: ${decision}.`, performedBy: userId || null });
    await chargeback.save();

    await AuditLogModel.create({ action: "finance.chargeback.resolve", module: "Finance", resource: "Chargeback", resourceId: chargeback._id.toString(), userId: userId || null, tenantId, details: { decision, journalId: journalId ? journalId.toString() : null } });
    publishEvent("ChargebackResolved", { tenantId, chargebackId: chargeback._id.toString(), paymentId: chargeback.paymentId.toString(), decision, amount: chargeback.amount, performedBy: userId || null });

    return chargeback.toJSON();
  }
}

export default ChargebackService;
