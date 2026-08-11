import mongoose from "mongoose";
import CustomerCreditModel from "../models/CustomerCreditModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

class CustomerCreditService {
  /**
   * "Credit balance created automatically" — called by
   * AccountsReceivableService.allocatePayment on overpayment, or directly
   * for a manual credit grant.
   */
  static async createCredit({ customerId, amount, currency, source, sourceReferenceId = null }, tenantId, userId) {
    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Credit amount must be greater than zero.");

    const credit = await CustomerCreditModel.create({
      tenantId,
      customerId,
      amount: roundedAmount,
      remainingAmount: roundedAmount,
      currency,
      source,
      sourceReferenceId,
      status: "Active",
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

  static async getAvailableCredit(customerId, tenantId) {
    const customerObjectId = typeof customerId === "string" ? new mongoose.Types.ObjectId(customerId) : customerId;
    const [result] = await CustomerCreditModel.aggregate([
      { $match: { tenantId, customerId: customerObjectId, status: "Active" } },
      { $group: { _id: null, total: { $sum: "$remainingAmount" } } }
    ]);
    return roundCurrency(result?.total || 0);
  }

  static async listCreditsForCustomer(customerId, tenantId) {
    return CustomerCreditModel.find({ tenantId, customerId, status: "Active" }).sort({ createdAt: 1 }).lean();
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

    return credit.toJSON();
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

    const credits = await CustomerCreditModel.find({ tenantId, customerId, currency, status: "Active" }).sort({ createdAt: 1 });
    for (const credit of credits) {
      if (remaining <= 0) break;
      const take = roundCurrency(Math.min(credit.remainingAmount, remaining));
      credit.remainingAmount = roundCurrency(credit.remainingAmount - take);
      if (credit.remainingAmount <= 0) credit.status = "Consumed";
      await credit.save();
      remaining = roundCurrency(remaining - take);
      consumedCreditIds.push(credit._id);
    }

    return { consumedAmount: roundCurrency(maxAmount - remaining), consumedCreditIds };
  }
}

export default CustomerCreditService;
