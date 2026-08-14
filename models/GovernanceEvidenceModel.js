import mongoose from "mongoose";

// Enterprise Governance Evidence Repository — Part 19.
// Permanent, cryptographically hashed evidence packages for external & internal audit compliance.
// Tenant-scoped only — no branchId per Master Architecture rules.
const GovernanceEvidenceSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  evidenceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  evaluationId: {
    type: String,
    required: true,
    index: true
  },
  transactionId: {
    type: String,
    required: true,
    index: true
  },
  operation: {
    type: String,
    required: true,
    index: true
  },
  evidenceType: {
    type: String,
    enum: ["ApprovalTrail", "PolicyCheckResult", "SoDVerification", "TaxValidation", "AuditPackage"],
    required: true,
    default: "AuditPackage",
    index: true
  },
  evidenceHash: {
    type: String,
    required: true,
    index: true
  },
  snapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  retentionYears: {
    type: Number,
    default: 7
  },
  legalHold: {
    type: Boolean,
    default: false,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { timestamps: true });

GovernanceEvidenceSchema.index({ tenantId: 1, evidenceHash: 1 });

GovernanceEvidenceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const GovernanceEvidenceModel = mongoose.model("governance_evidence", GovernanceEvidenceSchema);

export default GovernanceEvidenceModel;
