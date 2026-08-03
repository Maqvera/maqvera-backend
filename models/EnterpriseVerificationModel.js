import mongoose from "mongoose";

const EnterpriseVerificationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  branchId: {
    type: String,
    default: "main",
    index: true
  },
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "enterprise_document",
    required: true,
    index: true
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  versionNumber: {
    type: Number,
    default: 1
  },
  verificationStatus: {
    type: String,
    enum: ["pending", "processing", "ocr_complete", "ai_complete", "manual_review", "approved", "rejected", "reverification_required", "completed"],
    default: "pending",
    index: true
  },
  riskScore: {
    type: Number,
    default: 0
  },
  riskLevel: {
    type: String,
    enum: ["Low", "Medium", "High", "Critical"],
    default: "Low"
  },
  duplicateScore: {
    type: Number,
    default: 0
  },
  // Stage 1: Virus Scan Result
  virusScanResult: {
    status: { type: String, enum: ["clean", "infected", "skipped"], default: "clean" },
    engine: { type: String, default: "EnterpriseVirusScanner v2" },
    scannedAt: { type: Date, default: Date.now }
  },
  // Stage 2: OCR Extraction Result
  ocrResult: {
    status: { type: String, enum: ["pending", "processing", "completed", "failed"], default: "pending" },
    extractedFields: {
      passportNumber: { type: String, default: null },
      holderName: { type: String, default: null },
      nationality: { type: String, default: null },
      dateOfBirth: { type: Date, default: null },
      gender: { type: String, default: null },
      issueDate: { type: Date, default: null },
      expiryDate: { type: Date, default: null },
      mrz: { type: String, default: null },
      documentNumber: { type: String, default: null }
    },
    rawText: { type: String, default: null },
    completedAt: { type: Date, default: null }
  },
  // Stage 3: AI Validation Result
  aiValidationResult: {
    status: { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    confidenceScore: { type: Number, default: 0 },
    isBlurry: { type: Boolean, default: false },
    isCropped: { type: Boolean, default: false },
    tamperingDetected: { type: Boolean, default: false },
    faceDetected: { type: Boolean, default: true },
    signatureDetected: { type: Boolean, default: true },
    notes: { type: String, default: null },
    evaluatedAt: { type: Date, default: null }
  },
  // Stage 4: Duplicate Detection Result
  duplicateDetectionResult: {
    status: { type: String, enum: ["clean", "duplicate_suspected"], default: "clean" },
    duplicateScore: { type: Number, default: 0 },
    matchedDocumentIds: [{ type: mongoose.Schema.Types.ObjectId }],
    matchedCaseNumbers: [{ type: String }],
    analyzedAt: { type: Date, default: null }
  },
  // Stage 5: Business Rule Result
  businessRuleResult: {
    status: { type: String, enum: ["passed", "failed", "pending"], default: "pending" },
    rulesEvaluated: [
      {
        ruleCode: String,
        ruleName: String,
        status: { type: String, enum: ["passed", "failed"] },
        message: String
      }
    ],
    minimumValidityPassed: { type: Boolean, default: true },
    travelerMatchPassed: { type: Boolean, default: true },
    evaluatedAt: { type: Date, default: null }
  },
  // Stage 6: Manual Officer Review Result
  manualReviewResult: {
    status: { type: String, enum: ["pending", "completed"], default: "pending" },
    decision: { type: String, enum: ["Approved", "Rejected", "Needs Better Scan", "Needs Additional Pages", "Forgery Suspected", "Escalate", "pending"], default: "pending" },
    remarks: { type: String, default: null },
    reviewedBy: { type: String, default: null },
    reviewedByName: { type: String, default: null },
    reviewedAt: { type: Date, default: null }
  },
  // Stage 7: Final Verification Decision
  finalDecision: {
    decision: { type: String, enum: ["pending", "approved", "rejected", "reupload_required"], default: "pending" },
    isEmbassyReady: { type: Boolean, default: false },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null }
  },
  history: [mongoose.Schema.Types.Mixed],
  isSoftDeleted: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

EnterpriseVerificationSchema.index({ tenantId: 1, documentId: 1, versionNumber: 1 });

const EnterpriseVerificationModel = mongoose.model("enterprise_verification", EnterpriseVerificationSchema);

export default EnterpriseVerificationModel;
