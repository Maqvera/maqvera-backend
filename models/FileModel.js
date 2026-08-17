import mongoose from "mongoose";
import { applyEnterpriseMetadata, exposeVersion } from "../utils/enterpriseMetadata.js";
import { applyArchivalPolicy } from "../utils/archivalPolicy.js";

// Enterprise Architecture Hardening Phase — File Storage Standard
// (Improvement 12). "Binary files MUST NOT be stored inside operational
// databases" — this model stores exactly what the spec's own "Data
// Ownership" section says the database should hold: `fileId` + a
// `storageKey` reference into real object storage (`utils/fileStorage.js`
// — local/Cloudinary/S3, already real), never the binary itself.
//
// Deliberately generic/module-agnostic (`module` + `referenceType` +
// `referenceId`, not tied to one business domain) — a NEW, standard-
// compliant engine alongside the already-real, Visa-specific
// `services/EnterpriseDocumentService.js` (which already implements a
// real subset of this same standard: checksums, honest virus-scan
// labeling, versioning, signed URLs), not a replacement for it. See
// docs/07-enterprise-standards/12-file-storage.md "Relationship to
// EnterpriseDocumentService".
//
// Genuine reuse of three earlier standards in one model:
//   - Improvement 1 (Standard Metadata) — tenantId/companyId/
//     merchantAccountId/branchId/createdBy/updatedBy/version, opted in
//     with every identity dimension since a file can legitimately belong
//     to any of them.
//   - Improvement 10 (Soft Delete & Archival) + 11 (Data Retention &
//     Legal Hold) — isArchived/legalHold/purgeEligibleAt/retentionPolicy,
//     so `utils/archivalService.js#archiveRecord/restoreRecord/purgeRecord`
//     and `utils/legalHold.js` work against a FileModel row exactly the
//     way they work against any other archivable record.
const FileSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  // Which business module/record this file belongs to — e.g.
  // module: "Finance", referenceType: "Invoice", referenceId: the real
  // InvoiceModel _id (as a string; genuinely polymorphic, same
  // "informational, not FK-validated" treatment as other cross-context
  // references in this codebase).
  module: { type: String, required: true, index: true },
  referenceType: { type: String, default: null, index: true },
  referenceId: { type: String, default: null, index: true },

  fileName: { type: String, required: true },
  contentType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  checksum: { type: String, required: true },
  encrypted: { type: Boolean, required: true, default: false },
  // Config-driven (virusScanStatuses) — Skipped, Passed, Failed. A file
  // with status other than "Passed"/"Skipped" never reaches this
  // collection at all (utils/documentService.js rejects it before
  // storing) — see that file's own doc comment.
  virusScanStatus: { type: String, required: true },
  // Config-driven (storageClasses) — Hot, Warm, Cold.
  storageClass: { type: String, required: true },

  storageProvider: { type: String, required: true },
  // The real object-storage reference — never exposed directly in any
  // API response (`utils/documentService.js`'s own toJSON-equivalent
  // strips it); only a freshly-generated, time-limited signed URL is
  // ever returned to a caller.
  storageKey: { type: String, required: true },

  // Version chain — `rootFileId` is null on version 1 (which is its own
  // root); every subsequent version points back to it. "Never overwrite"
  // — a new version is always a NEW document row. Named `versionNumber`
  // (matching `services/EnterpriseDocumentService.js`'s own existing
  // field for the identical real concept), deliberately NOT `version` —
  // that name is already claimed by Improvement 1's `exposeVersion`
  // convention (the optimistic-concurrency counter, `__v`, a completely
  // different axis); reusing it here would silently overwrite one with
  // the other in every JSON response.
  versionNumber: { type: Number, required: true, default: 1 },
  rootFileId: { type: mongoose.Schema.Types.ObjectId, ref: "file", default: null, index: true },
  isLatestVersion: { type: Boolean, required: true, default: true, index: true },

  uploadedBy: { type: String, required: true },
  uploadedAt: { type: Date, required: true, default: Date.now },

  tags: { type: [String], default: [] }
}, { timestamps: true });

FileSchema.plugin(applyEnterpriseMetadata, { includeCompany: true, includeMerchant: true, includeBranch: true });
applyArchivalPolicy(FileSchema);

FileSchema.index({ tenantId: 1, module: 1, referenceType: 1, referenceId: 1, isLatestVersion: 1 });
FileSchema.index({ tenantId: 1, fileName: "text" });

FileSchema.set("toJSON", {
  transform: (doc, ret) => {
    exposeVersion(doc, ret);
    delete ret.storageKey; // "Never expose storage directly."
    return ret;
  }
});

const FileModel = mongoose.model("file", FileSchema);

export default FileModel;
