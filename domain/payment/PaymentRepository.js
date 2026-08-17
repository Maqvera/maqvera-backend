import PaymentModel from "../../models/PaymentModel.js";

/**
 * Payment Module Internal Domain Model (Improvement 16) — Repository.
 * "Find, Save, Archive, Search, Restore. Business logic nahi. Sirf
 * persistence." A thin wrapper over the existing PaymentModel — it does
 * not reimplement or duplicate any query the model didn't already support,
 * it just gives the Domain/Application layers one place to depend on
 * instead of importing the Mongoose model directly, so persistence can
 * change (a different ORM, a cache-through layer) without the Aggregate or
 * PaymentService needing to know.
 */
export class PaymentRepository {
  static async findById(paymentId, tenantId) {
    const payment = await PaymentModel.findOne({ _id: paymentId, tenantId });
    if (!payment) throw new Error("Payment not found.");
    return payment;
  }

  static async findByIdLean(paymentId, tenantId) {
    const payment = await PaymentModel.findOne({ _id: paymentId, tenantId }).lean();
    if (!payment) throw new Error("Payment not found.");
    return payment;
  }

  static async save(paymentDocument) {
    return paymentDocument.save();
  }

  static async list(filter, { sort, skip, limit } = {}) {
    const [items, total] = await Promise.all([
      PaymentModel.find(filter).sort(sort || { transactionDate: -1 }).skip(skip || 0).limit(limit || 20).lean(),
      PaymentModel.countDocuments(filter)
    ]);
    return { items, total };
  }
}

export default PaymentRepository;
