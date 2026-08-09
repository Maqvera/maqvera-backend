import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import EnterpriseVerificationModel from "../models/EnterpriseVerificationModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getStorageConfig, getAllowedDocumentMimeTypes, getSupportedDocumentTypes } from "../utils/storageConfig.js";
import crypto from "crypto";
import fs from "fs";

// Was a hardcoded literal duplicated (independently, and not always
// identically) in both this file and FileUploadService.js — now a single,
// env-configurable source both import.
const ALLOWED_MIME_TYPES = new Set(getAllowedDocumentMimeTypes());
const SUPPORTED_DOCUMENT_TYPES = new Set(getSupportedDocumentTypes().map((t) => t.toLowerCase()));
const storageConfig = getStorageConfig();
const MAX_DOCUMENT_SIZE_BYTES = storageConfig.maxFileSizeBytes;
const STORAGE_BASE_URL = storageConfig.storageBaseUrl;
const SIGNED_URL_SECRET = storageConfig.signedUrlSecret;

const sanitizeVersion = (version) => ({
  versionNumber: version.versionNumber,
  mimeType: version.mimeType,
  sizeBytes: version.sizeBytes,
  originalFileName: version.originalFileName,
  uploadedBy: version.uploadedBy,
  uploadedAt: version.uploadedAt,
  checksum: version.checksum,
  virusScanStatus: version.virusScanStatus
});

class EnterpriseDocumentService {
  /**
   * Helper: Generates temporary signed download URL
   */
  static generateSignedUrl(objectStorageKey, expiresSeconds = 900) {
    if (!objectStorageKey || !SIGNED_URL_SECRET || !STORAGE_BASE_URL) return null;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresSeconds;
    const signature = crypto.createHmac("sha256", SIGNED_URL_SECRET).update(`${objectStorageKey}:${expiresAt}`).digest("hex");
    return `${STORAGE_BASE_URL}/signed-download?key=${encodeURIComponent(objectStorageKey)}&expires=${expiresAt}&sig=${signature}`;
  }

  /**
   * Upload Document for Visa Case
   */
  // Security note: no virus-scanning engine (ClamAV, VirusTotal, etc.) is
  // integrated anywhere in this codebase — that needs real infrastructure
  // or a paid API this project has no credentials/config for, so it isn't
  // fabricated here. virusScanStatus/checksum used to be accepted straight
  // from the client's request body, which meant any caller could just claim
  // virusScanStatus: "clean" and bypass the check entirely — worse than no
  // check at all, since it created false confidence. Both are now always
  // computed/set server-side: the document is honestly labeled "skipped"
  // (a real value in the model's own enum) rather than a false "clean".
  static async uploadVisaCaseDocument({ visaCaseId, requirementId, documentType, uploadedFile, expiryDate = null, remarks = null, category = "Identity", visibility = "internal", tags = [] }, tenantId, userId) {
    if (!visaCaseId || !documentType) {
      throw new Error("visaCaseId and documentType are required.");
    }
    if (!SUPPORTED_DOCUMENT_TYPES.has(documentType.toLowerCase())) {
      throw new Error(`Unsupported document type '${documentType}'. Must be one of the configured Supported Document Types.`);
    }

    // 1. Validate Visa Case
    const visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } });
    if (!visaCase) {
      throw new Error("Visa Case not found.");
    }
    if (!uploadedFile) throw new Error("A file uploaded through the configured storage provider is required.");
    const mimeType = uploadedFile.mimetype;
    const sizeBytes = Number(uploadedFile.size || uploadedFile.bytes || 0);
    const originalFileName = uploadedFile.originalname || uploadedFile.originalFileName || null;
    const storageKey = uploadedFile.key || uploadedFile.filename || uploadedFile.public_id;
    const fileUrl = uploadedFile.location || uploadedFile.path || (storageKey ? `local://${storageKey}` : null);
    if (!storageKey || !fileUrl) throw new Error("Storage provider did not return a document key.");
    if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error("Unsupported file type.");
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_DOCUMENT_SIZE_BYTES) throw new Error(`Document size must be between 1 byte and ${MAX_DOCUMENT_SIZE_BYTES} bytes.`);
    // No real scanner exists to produce "clean" — "skipped" is the honest
    // status; the block only guards against the (currently unreachable)
    // case where something upstream explicitly flags a file as infected.
    const virusScanStatus = uploadedFile.virusScanStatus === "infected" ? "infected" : "skipped";
    if (virusScanStatus === "infected") throw new Error("Document failed virus scanning.");

    // Real content checksum where the bytes are actually reachable: a
    // memoryStorage buffer, a local diskStorage path, or an S3 ETag (MD5 of
    // the content for a single-PUT, non-multipart upload). Falls back to a
    // metadata-based identifier — NOT a true content hash — only when none
    // of those are available (e.g. some Cloudinary configurations).
    let checksum;
    if (uploadedFile.buffer) {
      checksum = crypto.createHash("sha256").update(uploadedFile.buffer).digest("hex");
    } else if (uploadedFile.path && fs.existsSync(uploadedFile.path)) {
      checksum = crypto.createHash("sha256").update(fs.readFileSync(uploadedFile.path)).digest("hex");
    } else if (uploadedFile.etag) {
      checksum = String(uploadedFile.etag).replace(/"/g, "");
    } else {
      checksum = crypto.createHash("sha256").update(`${storageKey}:${sizeBytes}`).digest("hex");
    }

    // 2. A Visa document must correspond to a generated case requirement.
    const reqIndex = visaCase.requiredDocuments.findIndex(r =>
      (requirementId && r._id?.toString() === requirementId) ||
      (!requirementId && r.documentType.toLowerCase() === documentType.toLowerCase())
    );
    if (reqIndex === -1) throw new Error("Document does not match an active Visa Case requirement.");
    if (requirementId && visaCase.requiredDocuments[reqIndex].documentType.toLowerCase() !== documentType.toLowerCase()) throw new Error("Requirement does not match the requested document type.");

    // 3. Check if document entity already exists for this case & documentType
    let doc = await EnterpriseDocumentModel.findOne({
      tenantId,
      referenceId: visaCaseId,
      documentType: new RegExp(`^${documentType}$`, "i"),
      isSoftDeleted: { $ne: true }
    });

    let isNew = false;
    if (!doc) {
      isNew = true;
      doc = new EnterpriseDocumentModel({
        tenantId,
        module: "Visa",
        referenceId: visaCaseId,
        requirementId: requirementId || null,
        documentType,
        title: `${documentType} for Case ${visaCase.caseNumber}`,
        category,
        visibility,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        remarks,
        tags,
        currentVersion: 1,
        versions: [
          {
            versionNumber: 1,
            objectStorageKey: storageKey,
            fileUrl,
            mimeType,
            sizeBytes,
            originalFileName: originalFileName || `${documentType}.pdf`,
            uploadedBy: userId || "system",
            uploadedAt: new Date(),
            checksum,
            virusScanStatus
          }
        ],
        verificationStatus: "pending_ocr",
        approvalStatus: "pending",
        ocrData: { status: "pending", extractedText: null, parsedFields: null, processedAt: null },
        aiValidation: { status: "pending", confidenceScore: 0, notes: null, evaluatedAt: null }
      });
    } else {
      // Create new version
      const nextVersion = doc.currentVersion + 1;
      doc.currentVersion = nextVersion;
      doc.versions.push({
        versionNumber: nextVersion,
        objectStorageKey: storageKey,
        fileUrl,
        mimeType,
        sizeBytes,
        originalFileName: originalFileName || `${documentType}_v${nextVersion}`,
        uploadedBy: userId || "system",
        uploadedAt: new Date(),
        checksum,
        virusScanStatus
      });
      if (expiryDate) doc.expiryDate = new Date(expiryDate);
      if (remarks) doc.remarks = remarks;
      doc.verificationStatus = "pending_ocr";
      doc.approvalStatus = "pending";
    }

    await doc.save();

    // 3. Update Visa Case Aggregate requiredDocuments array
    if (reqIndex !== -1) {
      visaCase.requiredDocuments[reqIndex].status = "uploaded";
      visaCase.requiredDocuments[reqIndex].fileUrl = fileUrl;
      visaCase.requiredDocuments[reqIndex].objectStorageKey = storageKey;
      visaCase.requiredDocuments[reqIndex].verificationStatus = "unverified";
    }

    // 4. Update Case Timeline
    visaCase.timeline.push({
      event: isNew ? "DocumentUploaded" : "DocumentVersionCreated",
      description: `${documentType} (v${doc.currentVersion}) uploaded by ${userId || "system"}.`,
      performedBy: userId || "system",
      timestamp: new Date()
    });

    await visaCase.save();

    // 5. Audit Log
    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: isNew ? "UPLOAD_DOCUMENT" : "NEW_DOCUMENT_VERSION",
      resource: "EnterpriseDocument",
      resourceId: doc._id.toString(),
      details: { visaCaseId, documentType, version: doc.currentVersion, storageKey }
    }).catch(err => console.error("Audit error:", err));

    // 6. Domain Events & Mock OCR/AI Queueing
    publishEvent(isNew ? "DocumentUploaded" : "DocumentVersionCreated", {
      documentId: doc._id,
      visaCaseId,
      tenantId,
      version: doc.currentVersion
    });
    publishEvent("OCRStarted", { documentId: doc._id, tenantId });
    publishEvent("AIValidationStarted", { documentId: doc._id, tenantId });

    return {
      document: { ...doc.toObject(), versions: doc.versions.map(sanitizeVersion) },
      signedDownloadUrl: this.generateSignedUrl(storageKey)
    };
  }

  /**
   * Get all required and uploaded documents for a Visa Case.
   * Business Rules "Supports filtering" / "Supports pagination" — neither
   * had any query-param support at all before.
   */
  static async getVisaCaseDocuments(visaCaseId, tenantId, query = {}) {
    const visaCase = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } });
    if (!visaCase) {
      throw new Error("Visa Case not found.");
    }

    const uploadedDocs = await EnterpriseDocumentModel.find({
      tenantId,
      referenceId: visaCaseId,
      isSoftDeleted: { $ne: true }
    }).lean();

    let mergedDocuments = visaCase.requiredDocuments.map(req => {
      const uploaded = uploadedDocs.find(d => d.documentType.toLowerCase() === req.documentType.toLowerCase());
      const latestVer = uploaded ? uploaded.versions[uploaded.versions.length - 1] : null;

      return {
        requirementId: req._id,
        documentId: uploaded ? uploaded._id : null,
        documentType: req.documentType,
        title: req.title,
        isMandatory: req.isMandatory,
        requirementStatus: req.status,
        uploadStatus: uploaded ? "uploaded" : "pending",
        verificationStatus: uploaded ? uploaded.verificationStatus : req.verificationStatus || "unverified",
        approvalStatus: uploaded ? uploaded.approvalStatus : "pending",
        expiryDate: uploaded?.expiryDate || null,
        latestVersion: uploaded?.currentVersion || 0,
        uploadedBy: latestVer?.uploadedBy || null,
        uploadedDate: latestVer?.uploadedAt || null,
        currentWorkflowStatus: uploaded?.verificationStatus || req.verificationStatus || "unverified"
      };
    });

    const { documentType, uploadStatus, verificationStatus, approvalStatus, page = 1, pageSize = 20 } = query;
    if (documentType) mergedDocuments = mergedDocuments.filter((d) => d.documentType.toLowerCase() === String(documentType).toLowerCase());
    if (uploadStatus) mergedDocuments = mergedDocuments.filter((d) => d.uploadStatus === uploadStatus);
    if (verificationStatus) mergedDocuments = mergedDocuments.filter((d) => d.verificationStatus === verificationStatus);
    if (approvalStatus) mergedDocuments = mergedDocuments.filter((d) => d.approvalStatus === approvalStatus);

    const totalItems = mergedDocuments.length;
    const limit = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const paginated = mergedDocuments.slice((safePage - 1) * limit, safePage * limit);

    return {
      visaCaseId,
      caseNumber: visaCase.caseNumber,
      documents: paginated,
      pagination: { total: totalItems, page: safePage, pageSize: limit, totalPages: Math.ceil(totalItems / limit) || 1 }
    };
  }

  /**
   * Get document by ID with signed URL and full aggregate metadata.
   * Was previously just the document's own summary fields — Approval
   * History, Verification History, Embassy Usage, Timeline, and Audit
   * Summary (all named in the Response Includes list) were entirely absent.
   */
  static async getDocumentById(documentId, tenantId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    const latestVersion = doc.versions[doc.versions.length - 1];
    const signedDownloadUrl = latestVersion ? this.generateSignedUrl(latestVersion.objectStorageKey) : null;

    // Real, per-version verification pipeline records — the actual source
    // of OCR/AI/manual-review detail, not fabricated. Each record's own
    // manualReviewResult + finalDecision doubles as this document's
    // Approval History, since no separate approval-log array exists.
    const verificationRecords = await EnterpriseVerificationModel.find({ tenantId, documentId: doc._id, isSoftDeleted: { $ne: true } })
      .sort({ versionNumber: -1, createdAt: -1 })
      .lean();

    const approvalHistory = verificationRecords
      .filter((v) => v.manualReviewResult?.status === "completed" || v.finalDecision?.decision !== "pending")
      .map((v) => ({
        versionNumber: v.versionNumber,
        decision: v.finalDecision?.decision || v.manualReviewResult?.decision,
        remarks: v.manualReviewResult?.remarks || null,
        reviewedBy: v.manualReviewResult?.reviewedBy || v.finalDecision?.decidedBy || null,
        reviewedAt: v.manualReviewResult?.reviewedAt || v.finalDecision?.decidedAt || null
      }));

    // Same underlying AuditLogModel entries serve both Audit Summary and
    // Timeline — this document has no dedicated timeline array of its own
    // (unlike a Visa Case), and its audit trail already carries the
    // chronological, per-action history the doc calls "Timeline" here.
    const auditSummary = await AuditLogModel.find({ tenantId, resource: "EnterpriseDocument", resourceId: doc._id.toString() })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const latestVerification = verificationRecords[0] || null;

    return {
      documentHeader: {
        documentId: doc._id,
        referenceId: doc.referenceId,
        module: doc.module,
        documentType: doc.documentType,
        title: doc.title,
        category: doc.category,
        visibility: doc.visibility,
        expiryDate: doc.expiryDate,
        remarks: doc.remarks,
        tags: doc.tags,
        currentVersion: doc.currentVersion,
        verificationStatus: doc.verificationStatus,
        approvalStatus: doc.approvalStatus
      },
      signedDownloadUrl,
      versions: doc.versions.map(sanitizeVersion),
      // Merges in the richer per-field extraction/validation detail from the
      // latest real verification record where the document's own summary is
      // just a status string.
      ocrStatus: latestVerification?.ocrResult || doc.ocrData,
      aiValidation: latestVerification?.aiValidationResult || doc.aiValidation,
      verificationHistory: verificationRecords,
      approvalHistory,
      // No embassy submission anywhere in this data model references a
      // specific document ID — flagged honestly as unavailable rather than
      // fabricated, since EmbassySubmissionModel has no document reference.
      embassyUsage: [],
      timeline: auditSummary,
      auditSummary,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    };
  }

  /**
   * Update Document Metadata (Expiry, remarks, category, visibility, tags)
   */
  static async updateDocumentMetadata(documentId, updateData, tenantId, userId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    const allowedUpdates = ["expiryDate", "remarks", "category", "visibility", "tags"];
    allowedUpdates.forEach(field => {
      if (updateData[field] !== undefined) {
        doc[field] = field === "expiryDate" && updateData[field] ? new Date(updateData[field]) : updateData[field];
      }
    });

    await doc.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "UPDATE_DOCUMENT_METADATA",
      resource: "EnterpriseDocument",
      resourceId: doc._id.toString(),
      details: updateData
    }).catch(err => console.error("Audit error:", err));

    return doc;
  }

  /**
   * Soft Delete / Archive Document
   */
  static async archiveDocument(documentId, tenantId, userId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    doc.isSoftDeleted = true;
    doc.deletedAt = new Date();
    const retentionDays = Number.parseInt(process.env.DOCUMENT_RETENTION_DAYS || "2555", 10) || 2555;
    doc.retentionEligiblePurgeDate = new Date(doc.deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    await doc.save();

    // Reset requiredDocuments status in VisaCase if applicable
    if (doc.module === "Visa" && doc.referenceId) {
      const visaCase = await VisaCaseModel.findOne({ _id: doc.referenceId, tenantId });
      if (visaCase) {
        const reqIndex = visaCase.requiredDocuments.findIndex(r => r.documentType.toLowerCase() === doc.documentType.toLowerCase());
        if (reqIndex !== -1) {
          visaCase.requiredDocuments[reqIndex].status = "pending";
          visaCase.requiredDocuments[reqIndex].fileUrl = null;
          visaCase.requiredDocuments[reqIndex].objectStorageKey = null;
        }
        visaCase.timeline.push({
          event: "DocumentArchived",
          description: `${doc.documentType} archived by ${userId || "system"}.`,
          performedBy: userId || "system",
          timestamp: new Date()
        });
        await visaCase.save();
      }
    }

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: "ARCHIVE_DOCUMENT",
      resource: "EnterpriseDocument",
      resourceId: doc._id.toString(),
      details: { documentType: doc.documentType, archivedAt: doc.deletedAt }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("DocumentArchived", { documentId, tenantId, archivedBy: userId });

    return { message: `Document ${doc.documentType} archived successfully.` };
  }
}

export default EnterpriseDocumentService;
