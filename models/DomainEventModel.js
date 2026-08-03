import mongoose from "mongoose";

// Durable audit/outbox record for events emitted by the in-process dispatcher.
// It lets workers, monitoring, and a future broker adapter replay business
// events without coupling bounded contexts through direct collection writes.
const DomainEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  eventType: { type: String, required: true, index: true },
  tenantId: { type: String, default: null, index: true },
  branchId: { type: String, default: null, index: true },
  correlationId: { type: String, default: null, index: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  occurredAt: { type: Date, required: true, default: Date.now, index: true },
  deliveryStatus: { type: String, enum: ["queued", "dispatched", "dispatch_failed"], default: "queued", index: true },
  dispatchedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
}, { timestamps: true });

DomainEventSchema.index({ tenantId: 1, eventType: 1, occurredAt: -1 });

export default mongoose.model("domain_event", DomainEventSchema);
