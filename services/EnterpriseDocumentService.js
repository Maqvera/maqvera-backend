import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getStorageConfig } from "../utils/storageConfig.js";
import crypto from "crypto";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
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
  static async uploadVisaCaseDocument({ visaCaseId, requirementId, documentType, uploadedFile, expiryDate = null, remarks = null, category = "Identity", visibility = "internal", tags = [], checksum = null, virusScanStatus = "clean" }, tenantId, branchId, userId) {
    if (!visaCaseId || !documentType) {
      throw new Error("visaCaseId and documentType are required.");
    }

    // 1. Validate Visa Case
    const caseFilter = { _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } };
    if (branchId) caseFilter.branchId = branchId;
    const visaCase = await VisaCaseModel.findOne(caseFilter);
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
    if (virusScanStatus !== "clean") throw new Error("Document must pass virus scanning before upload.");

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
        branchId: branchId || visaCase.branchId || "main",
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
            checksum: checksum || crypto.createHash("sha256").update(`${storageKey}:${sizeBytes}`).digest("hex"),
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
        checksum: checksum || crypto.createHash("sha256").update(`${storageKey}:${sizeBytes}`).digest("hex"),
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
   * Get all required and uploaded documents for a Visa Case
   */
  static async getVisaCaseDocuments(visaCaseId, tenantId, branchId) {
    const caseFilter = { _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } };
    if (branchId) caseFilter.branchId = branchId;
    const visaCase = await VisaCaseModel.findOne(caseFilter);
    if (!visaCase) {
      throw new Error("Visa Case not found.");
    }

    const documentFilter = {
      tenantId,
      referenceId: visaCaseId,
      isSoftDeleted: { $ne: true }
    };
    if (branchId) documentFilter.branchId = branchId;
    const uploadedDocs = await EnterpriseDocumentModel.find(documentFilter).lean();

    const mergedDocuments = visaCase.requiredDocuments.map(req => {
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

    return {
      visaCaseId,
      caseNumber: visaCase.caseNumber,
      documents: mergedDocuments
    };
  }

  /**
   * Get document by ID with signed URL and full metadata
   */
  static async getDocumentById(documentId, tenantId) {
    const doc = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } });
    if (!doc) {
      throw new Error("Document not found.");
    }

    const latestVersion = doc.versions[doc.versions.length - 1];
    const signedDownloadUrl = latestVersion ? this.generateSignedUrl(latestVersion.objectStorageKey) : null;

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
      ocrStatus: doc.ocrData,
      aiValidation: doc.aiValidation,
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
