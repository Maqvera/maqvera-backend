import { Entity } from "../../shared/Entity.js";

// Payment Module Internal Domain Model (Improvement 16) — Entity (owned by
// the Payment aggregate root; never addressed/updated directly — mirrors
// the real `PaymentAllocationSchema` sub-document in models/PaymentModel.js,
// which is exactly why this stays a thin, faithful wrapper rather than a
// second, drifting definition of what an allocation is.
export class PaymentAllocation extends Entity {
  constructor({ _id, targetType, targetId, amount, allocatedAt, allocatedBy }) {
    super(_id ? String(_id) : `${targetType}:${targetId}:${amount}:${Date.now()}`);
    if (!targetType || !targetId) throw new Error("PaymentAllocation requires targetType and targetId.");
    if (!amount || amount <= 0) throw new Error("PaymentAllocation requires a positive amount.");
    this.targetType = targetType;
    this.targetId = targetId;
    this.amount = amount;
    this.allocatedAt = allocatedAt || new Date();
    this.allocatedBy = allocatedBy || null;
  }
}
