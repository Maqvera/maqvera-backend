import mongoose from "mongoose";
import CustomerCreditModel from "../models/CustomerCreditModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** "Credit Expiry Rules" — pure: a credit is usable only while Active AND not past its own expiresAt (null = never expires). */
export const isCreditUsable = (credit, referenceDate = new Date()) => credit.status === "Active" && (!credit.expiresAt || new Date(credit.expiresAt) >= referenceDate);

class CustomerCreditService {
  /**
   * "Credit balance created automatically" — called by
   * AccountsReceivableService.allocatePayment on overpayment, or directly
   * for a manual credit grant. `expiresAt` is caller-overridable; falls
   * back to the tenant's own `customerCreditDefaultExpiryDays` (0 = never).
   */
  static async createCredit({ customerId, amount, currency, source, sourceReferenceId = null, expiresAt = undefined }, tenantId, userId) {
    const config = getFinanceConfig();
    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Credit amount must be greater than zero.");

    const resolvedExpiresAt = expiresAt !== undefined ? (expiresAt ? new Date(expiresAt) : null)
      : (config.customerCreditDefaultExpiryDays > 0 ? new Date(Date.now() + config.customerCreditDefaultExpiryDays * 86400000) : null);

    const credit = await CustomerCreditModel.create({
      tenantId,
      customerId,
      amount: roundedAmount,
      remainingAmount: roundedAmount,
      currency,
      source,
      sourceReferenceId,
      status: "Active",
      expiresAt: resolvedExpiresAt,
      createdBy: userId || null
    });

    await AuditLogModel.create({
      action: "finance.credit.create",
      module: "Finance",
      resource: "CustomerCredit",
      resourceId: credit._id.toString(),
      userId: userId || null,
      tenantId,
      details: { customerId: customerId.toString(), amount: roundedAmount, source }
    });

    publishEvent("CustomerCreditCreated", { tenantId, creditId: credit._id.toString(), customerId: customerId.toString(), amount: roundedAmount, source, performedBy: userId || null });

    return credit.toJSON();
  }

  // `currency` is optional (unlike VendorCreditService's own
  // currency-required getAvailableCredit) — every pre-existing caller here
  // wants the customer's whole cross-currency balance; `allocateAdvance`
  // (File 6 Part 5) passes it to match the exact currency it's about to
  // call `consumeAvailableCredits` for, since that consumption path is
  // (correctly) currency-scoped and a cross-currency total would
  // overstate what's actually consumable against one collection.
  static async getAvailableCredit(customerId, tenantId, currency = null) {
    const customerObjectId = typeof customerId === "string" ? new mongoose.Types.ObjectId(customerId) : customerId;
    const match = { tenantId, customerId: customerObjectId, status: "Active", $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }] };
    if (currency) match.currency = currency;
    const [result] = await CustomerCreditModel.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: "$remainingAmount" } } }
    ]);
    return roundCurrency(result?.total || 0);
  }

  static async listCreditsForCustomer(customerId, tenantId) {
    return CustomerCreditModel.find({ tenantId, customerId, status: "Active", $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }] }).sort({ createdAt: 1 }).lean();
  }

  /**
   * GET /api/v1/customer-credits — "Customer Credit Balance Management."
   * Tenant-wide list (the pre-existing `listCreditsForCustomer` above stays
   * as the narrower, Active-only, single-customer helper other services
   * already call). Lazily flips a past-`expiresAt`-but-still-`Active`
   * credit to `Expired` as it's read (see `expiresAt`'s own schema doc
   * comment for why this is lazy, not scheduler-driven) so the returned
   * `status` is always accurate at read time even though nothing proactively
   * swept it.
   */
  static async listCredits(query, tenantId) {
    const config = getFinanceConfig();
    const { customerId, status, currency } = query;
    const filter = { tenantId };
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

    const [items, total] = await Promise.all([
      CustomerCreditModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      CustomerCreditModel.countDocuments(filter)
    ]);

    const now = new Date();
    const staleActiveIds = items.filter((c) => c.status === "Active" && c.expiresAt && new Date(c.expiresAt) < now).map((c) => c._id);
    if (staleActiveIds.length > 0) {
      await CustomerCreditModel.updateMany({ _id: { $in: staleActiveIds }, tenantId }, { $set: { status: "Expired" } });
      items.forEach((c) => { if (staleActiveIds.some((id) => id.equals(c._id))) c.status = "Expired"; });
      for (const creditId of staleActiveIds) publishEvent("CustomerCreditExpired", { tenantId, creditId: creditId.toString(), performedBy: "system" });
    }

    return {
      items: items.map((c) => ({
        creditId: c._id, customer: c.customerId, availableCredit: c.remainingAmount, usedCredit: roundCurrency(c.amount - c.remainingAmount),
        remainingCredit: c.remainingAmount, currency: c.currency, status: c.status, source: c.source, expiryDate: c.expiresAt, createdAt: c.createdAt
      })),
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
    };
  }

  /**
   * Consumes a SPECIFIC credit record by id, not FIFO across every Active
   * credit for the customer (unlike consumeAvailableCredits below). Used by
   * RefundService.processRefund (Part 12) to redeem the exact CustomerCredit
   * a Credit Note's own allocation produced (`creditNote.customerCreditId`)
   * as a real cash/wallet payout — deliberately targeted so a refund never
   * accidentally drains an unrelated, older credit.
   */
  static async consumeCreditById(creditId, tenantId, amount) {
    const credit = await CustomerCreditModel.findOne({ _id: creditId, tenantId });
    if (!credit) throw new Error("Customer credit not found.");
    if (credit.status !== "Active") throw new Error(`Customer credit is not Active (status: "${credit.status}").`);

    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Amount must be greater than zero.");
    if (roundedAmount > credit.remainingAmount) {
      throw new Error(`Requested amount ${roundedAmount} exceeds the credit's remaining balance (${credit.remainingAmount}).`);
    }

    credit.remainingAmount = roundCurrency(credit.remainingAmount - roundedAmount);
    if (credit.remainingAmount <= 0) credit.status = "Consumed";
    await credit.save();

    await CustomerCreditService._publishConsumptionEvents(tenantId, credit, roundedAmount);

    return credit.toJSON();
  }

  /** Real, deterministic — "CustomerCreditConsumed"/"DepositApplied" (Part 18 Part 5's own Domain Events list). DepositApplied fires only when the consumed credit's own `source` is one of the configured deposit source types, never guessed. */
  static async _publishConsumptionEvents(tenantId, credit, amountConsumed) {
    const config = getFinanceConfig();
    publishEvent("CustomerCreditConsumed", { tenantId, creditId: credit._id.toString(), customerId: credit.customerId.toString(), amount: amountConsumed, remainingAmount: credit.remainingAmount, source: credit.source, performedBy: "system" });
    if (config.customerDepositSourceTypes.includes(credit.source)) {
      publishEvent("DepositApplied", { tenantId, creditId: credit._id.toString(), customerId: credit.customerId.toString(), amount: amountConsumed, source: credit.source, performedBy: "system" });
    }
    const availableCredit = await CustomerCreditService.getAvailableCredit(credit.customerId, tenantId);
    publishEvent("CustomerBalanceUpdated", { tenantId, customerId: credit.customerId.toString(), availableCredit, currency: credit.currency, performedBy: "system" });
  }

  /**
   * "Customer Credit Wallet... Reusable across invoices" (Part 10) —
   * consumes the customer's oldest Active credits first, up to `maxAmount`,
   * and returns how much was actually applied. Mirrors
   * VendorCreditService.consumeAvailableCredits exactly (AP has used this
   * exact pattern since Part 6); AR never had an equivalent for the
   * customer side until now — this was explicitly deferred in Part 5
   * ("Applying existing credit to a receivable has no endpoint yet") and is
   * completed here now that Part 10 names a concrete event (`CreditApplied`)
   * for it. Used by AccountsReceivableService.createReceivable.
   */
  static async consumeAvailableCredits(customerId, tenantId, currency, maxAmount) {
    let remaining = roundCurrency(maxAmount);
    const consumedCreditIds = [];
    if (remaining <= 0) return { consumedAmount: 0, consumedCreditIds };

    const credits = await CustomerCreditModel.find({ tenantId, customerId, currency, status: "Active", $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }] }).sort({ createdAt: 1 });
    for (const credit of credits) {
      if (remaining <= 0) break;
      const take = roundCurrency(Math.min(credit.remainingAmount, remaining));
      credit.remainingAmount = roundCurrency(credit.remainingAmount - take);
      if (credit.remainingAmount <= 0) credit.status = "Consumed";
      await credit.save();
      remaining = roundCurrency(remaining - take);
      consumedCreditIds.push(credit._id);
      await CustomerCreditService._publishConsumptionEvents(tenantId, credit, take);
    }

    return { consumedAmount: roundCurrency(maxAmount - remaining), consumedCreditIds };
  }
}

export default CustomerCreditService;
