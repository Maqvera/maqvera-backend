import mongoose from "mongoose";

const EnterpriseDocumentSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  module: {
    type: String,
    enum: ["Visa", "Customer", "Booking", "Finance", "HR", "Compliance", "AI"],
    default: "Visa",
    index: true
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  requirementId: {
    type: String,
    default: null,
    index: true
  },
  documentType: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    default: null
  },
  category: {
    type: String,
    default: "Identity"
  },
  visibility: {
    type: String,
    enum: ["internal", "public", "embassy_only"],
    default: "internal"
  },
  expiryDate: {
    type: Date,
    default: null,
    index: true
  },
  // "Document Expiry ... Automatic reminders supported" — tracked by
  // documentExpiryScheduler.js rather than overloading verificationStatus/
  // approvalStatus (a document expiring is a different concern from its
  // verification/approval outcome).
  isExpired: {
    type: Boolean,
    default: false,
    index: true
  },
  expiredAt: {
    type: Date,
    default: null
  },
  expiryReminderSentAt: {
    type: Date,
    default: null
  },
  remarks: {
    type: String,
    default: null
  },
  tags: [{ type: String }],
  currentVersion: {
    type: Number,
    default: 1
  },
  versions: [
    {
      versionNumber: { type: Number, required: true },
      objectStorageKey: { type: String, required: true },
      fileUrl: { type: String, required: true },
      mimeType: { type: String, default: "application/pdf" },
      sizeBytes: { type: Number, default: 0 },
      originalFileName: { type: String, default: null },
      uploadedBy: { type: String, default: "system" },
      uploadedAt: { type: Date, default: Date.now },
      checksum: { type: String, default: null },
      virusScanStatus: { type: String, enum: ["clean", "infected", "pending", "skipped"], default: "clean" }
    }
  ],
  verificationStatus: {
    type: String,
    enum: ["unverified", "pending_ocr", "pending_ai", "verified", "rejected"],
    default: "unverified",
    index: true
  },
  approvalStatus: {
    type: String,
    enum: ["pending", "approved", "rejected", "reupload_required"],
    default: "pending",
    index: true
  },
  ocrData: {
    status: { type: String, enum: ["pending", "processing", "completed", "failed"], default: "pending" },
    extractedText: { type: String, default: null },
    parsedFields: mongoose.Schema.Types.Mixed,
    processedAt: { type: Date, default: null }
  },
  aiValidation: {
    status: { type: String, enum: ["pending", "passed", "failed"], default: "pending" },
    confidenceScore: { type: Number, default: 0 },
    notes: { type: String, default: null },
    evaluatedAt: { type: Date, default: null }
  },
  isSoftDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date,
    default: null
  },
  // "Retention policy configurable" — the date after which this archived
  // document is eligible for permanent purge, per DOCUMENT_RETENTION_DAYS.
  // No automated purge job runs against this (deleting real files is not
  // something to automate without a live environment to verify against) —
  // it's tracked as real, honest metadata for a future/manual purge pass.
  retentionEligiblePurgeDate: {
    type: Date,
    default: null
  }
}, { timestamps: true });

EnterpriseDocumentSchema.index({ tenantId: 1, referenceId: 1, documentType: 1 });

const EnterpriseDocumentModel = mongoose.model("enterprise_document", EnterpriseDocumentSchema);

export default EnterpriseDocumentModel;
