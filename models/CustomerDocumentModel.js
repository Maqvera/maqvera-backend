import mongoose from "mongoose";

const CustomerDocumentSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customer",
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  // Matches the "Supported Documents" list (Part 4). proof_of_address is kept
  // for backward compatibility with documents uploaded before this list existed.
  documentType: {
    type: String,
    enum: [
      "passport_scan", "national_id", "visa_copy", "photo", "vaccination_certificate",
      "travel_insurance", "marriage_certificate", "birth_certificate", "mahram_certificate",
      "proof_of_address", "other"
    ],
    default: "other",
    index: true
  },
  documentNumber: {
    type: String,
    default: null
  },
  storageProvider: {
    type: String,
    default: null
  },
  storageKey: {
    type: String,
    default: null
  },
  fileName: {
    type: String,
    required: true
  },
  // Never trusted from client input and never returned raw — the storage key
  // is internal. Reads compute a short-lived HMAC-signed URL on the fly
  // (see EnterpriseDocumentService.generateSignedUrl), so no permanent URL
  // is persisted here.
  fileUrl: {
    type: String,
    default: null
  },
  mimeType: {
    type: String,
    default: null
  },
  fileSize: {
    type: Number,
    default: 0
  },
  expiryDate: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ["pending_scan", "scanning", "verified", "rejected", "archived"],
    default: "pending_scan",
    index: true
  },
  version: {
    type: Number,
    default: 1
  },
  uploadedBy: {
    type: String,
    default: null
  },
  virusScanStatus: {
    type: String,
    enum: ["pending", "clean", "infected"],
    default: "pending"
  },
  verifiedBy: {
    type: String,
    default: null
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  rejectionReason: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: null
  }
}, { timestamps: true });

const CustomerDocumentModel = mongoose.model("customer_document", CustomerDocumentSchema);

export default CustomerDocumentModel;
