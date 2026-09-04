import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Resilience & Reliability
// Standard (Improvement 6). Circuit Breaker state is per EXTERNAL
// INTEGRATION, not per tenant — "Bank API down hai" is true for every
// tenant using this ERP instance at once, not one tenant's own problem.
// `utils/resilienceEngine.js` keeps the hot-path check in an in-memory
// Map (a DB round-trip on every single external call would defeat the
// point of a fast-fail breaker); this collection is the durable,
// queryable history behind the "Circuit Breaker Status" dashboard metric
// the spec's own Monitoring section asks for, and survives a process
// restart (a fresh in-memory breaker always starts Closed, which is the
// correct, safe default either way — this collection is for
// observability, not for reconstructing in-memory state).
const CircuitBreakerStateSchema = new mongoose.Schema({
  integration: { type: String, required: true, unique: true, index: true },
  // Closed -> Open -> HalfOpen -> Closed.
  state: { type: String, required: true, default: "Closed" },
  consecutiveFailureCount: { type: Number, default: 0 },
  openedAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  transitions: [{
    fromState: { type: String, required: true },
    toState: { type: String, required: true },
    reason: { type: String, default: null },
    occurredAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

CircuitBreakerStateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CircuitBreakerStateModel = mongoose.model("circuit_breaker_state", CircuitBreakerStateSchema);

export default CircuitBreakerStateModel;
