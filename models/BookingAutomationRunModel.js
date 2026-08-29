import mongoose from "mongoose";

// One-Click Automation Engine (PRD "CRM Feature Map by Phase" Phase 3
// module 22) — a persisted, inspectable record of one automation run,
// deliberately NOT built on WorkflowEngine.js/WorkflowInstanceModel: that
// engine is a pure named-state state-machine (fixed entityType enum, no
// step-execution or per-step result concept) — bolting a step-orchestrator
// onto it would mean widening a shared, already-relied-upon engine rather
// than composing on top of it. Each step here is independent and
// additive (visa case / invoice / WhatsApp message), so this deliberately
// carries no compensation/rollback bookkeeping — see
// BookingOneClickAutomationService.js's own doc comment for why that's
// safe for exactly this step set, and why flight/hotel/payment-reminder
// steps are NOT included yet.
const AutomationStepSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: { type: String, enum: ["success", "skipped", "failed"], required: true },
  detail: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  durationMs: { type: Number, default: 0 }
}, { _id: false });

const BookingAutomationRunSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "booking_header", required: true, index: true },
  status: { type: String, enum: ["completed", "partial"], required: true },
  steps: { type: [AutomationStepSchema], default: [] },
  triggeredBy: { type: String, default: null }
}, { timestamps: true });

BookingAutomationRunSchema.index({ tenantId: 1, bookingId: 1, createdAt: -1 });

BookingAutomationRunSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const BookingAutomationRunModel = mongoose.model("booking_automation_run", BookingAutomationRunSchema);

export default BookingAutomationRunModel;
