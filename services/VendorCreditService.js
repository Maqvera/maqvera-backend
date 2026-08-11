import VendorCreditModel from "../models/VendorCreditModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

class VendorCreditService {
  /** "Credit balance created automatically" on vendor overpayment, or a direct manual/advance grant. */
  static async createCredit({ vendorId, amount, currency, source, sourceReferenceId = null }, tenantId, userId) {
    const roundedAmount = roundCurrency(amount);
    if (roundedAmount <= 0) throw new Error("Credit amount must be greater than zero.");

    const credit = await VendorCreditModel.create({
      tenantId,
      vendorId,
      amount: roundedAmount,
      remainingAmount: roundedAmount,
      currency,
      source,
      sourceReferenceId,
      status: "Active",
      createdBy: userId || null
    });

    await AuditLogModel.create({
      action: "finance.vendorcredit.create",
      module: "Finance",
      resource: "VendorCredit",
      resourceId: credit._id.toString(),
      userId: userId || null,
      tenantId,
      details: { vendorId: vendorId.toString(), amount: roundedAmount, source }
    });

    publishEvent("VendorCreditCreated", { tenantId, creditId: credit._id.toString(), vendorId: vendorId.toString(), amount: roundedAmount, source, performedBy: userId || null });

    return credit.toJSON();
  }

  static async getAvailableCredit(vendorId, tenantId, currency) {
    const [result] = await VendorCreditModel.aggregate([
      { $match: { tenantId, vendorId, currency, status: "Active" } },
      { $group: { _id: null, total: { $sum: "$remainingAmount" } } }
    ]);
    return roundCurrency(result?.total || 0);
  }

  /**
   * "Advance linked automatically when invoice arrives" — consumes the
   * vendor's oldest Active credits first, up to `maxAmount`, and returns
   * how much was actually applied. Used by AccountsPayableService.createPayable.
   */
  static async consumeAvailableCredits(vendorId, tenantId, currency, maxAmount) {
    let remaining = roundCurrency(maxAmount);
    const consumedCreditIds = [];
    if (remaining <= 0) return { consumedAmount: 0, consumedCreditIds };

    const credits = await VendorCreditModel.find({ tenantId, vendorId, currency, status: "Active" }).sort({ createdAt: 1 });
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

export default VendorCreditService;
