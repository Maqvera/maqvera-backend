import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Data Retention & Legal Hold
// Standard (Improvement 11). "Purge Approval — Retention Complete ->
// Compliance Officer -> Finance Manager -> System Approval -> Secure
// Purge -> Audit Event. No automatic deletion without approval." A real,
// queryable "Purge Queue"/"Purge History" (the compliance dashboard
// requirement) — deliberately a simple, standalone request/approve gate
// (`utils/purgeRequest.js`), not a second, competing implementation of
// this codebase's own general-purpose `services/ApprovalWorkflowService.js`.
// Once `approvePurge` marks a request Approved, the caller passes that
// real `approvedBy` into Improvement 10's own `purgeRecord` — this model
// never performs the actual delete itself.
const PurgeRequestSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  resourceType: { type: String, required: true, index: true },
  resourceId: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  // Config-driven (purgeRequestStatuses) — Pending, Approved, Rejected, Completed.
  status: { type: String, required: true, default: "Pending", index: true },
  requestedBy: { type: String, required: true },
  requestedAt: { type: Date, default: Date.now },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: String, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true, optimisticConcurrency: true });

PurgeRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

PurgeRequestSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PurgeRequestModel = mongoose.model("purge_request", PurgeRequestSchema);

export default PurgeRequestModel;
