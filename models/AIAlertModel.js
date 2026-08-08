import mongoose from "mongoose";

/**
 * EXT-033 §19 "Alerting ... Alerts configurable." Real, DB-backed alert
 * state so a breached threshold opens exactly one row (never re-fires every
 * sweep while still breached) and a recovered metric resolves it — the same
 * de-dup discipline `aiApprovalTimeoutScheduler.js` already applies via its
 * own `reminderSentAt`/`escalatedAt` timestamps, generalized here into an
 * explicit active/resolved lifecycle since alerts (unlike a one-shot
 * reminder) need to reflect an ongoing condition that can clear on its own.
 */
const AIAlertSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    alertType: {
      type: String,
      enum: ["high_failure_rate", "high_latency", "high_hallucination_rate", "high_tool_failure_rate", "cost_spike", "high_guardrail_block_rate", "provider_unavailable"],
      required: true
    },
    severity: { type: String, enum: ["warning", "critical"], required: true },
    message: { type: String, required: true },
    metricValue: { type: Number, default: null },
    thresholdValue: { type: Number, default: null },
    status: { type: String, enum: ["active", "resolved"], default: "active", index: true },
    triggeredAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AIAlertSchema.index({ tenantId: 1, status: 1, alertType: 1 });

export default mongoose.models.AIAlert || mongoose.model("AIAlert", AIAlertSchema);
