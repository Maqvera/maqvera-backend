import crypto from "crypto";
import FileModel from "../models/FileModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { saveBookingDocumentFile } from "./fileStorage.js";
import { getAllowedDocumentMimeTypes, getStorageConfig } from "./storageConfig.js";
import { encryptBuffer } from "./fileEncryption.js";
import { scanBuffer } from "./virusScanAdapter.js";
import { getDocumentServiceConfig } from "./documentServiceConfig.js";
import { getCorrelationId } from "./correlationContext.js";
import { publishVersionedEvent } from "./eventVersioning.js";
import { resolveRetentionYears } from "./retentionPolicy.js";
import { archiveRecord, restoreRecord, purgeRecord } from "./archivalService.js";
import { applyLegalHold, removeLegalHold } from "./legalHold.js";
import { AppError } from "./errorContract.js";

/**
 * Enterprise File Storage Standard (Enterprise Architecture Hardening
 * Phase, Improvement 12). The real, generic, standard-compliant document
 * engine — genuine reuse, not reinvention, at every layer:
 *   - `utils/fileStorage.js#saveBookingDocumentFile` for actual bytes-on-
 *     disk/S3/Cloudinary (already real, already used by Booking).
 *   - `utils/fileEncryption.js` for real AES-256-GCM at rest.
 *   - `utils/virusScanAdapter.js` for an honest, pluggable scan result.
 *   - `utils/retentionPolicy.js#resolveRetentionYears` (Improvement 11)
 *     for the real retention window.
 *   - `utils/archivalService.js` (Improvement 10) for archive/restore/
 *     purge — this file's own archive/restore/purge wrappers add nothing
 *     but a file-specific domain event on top of the exact same real gates.
 *   - `utils/legalHold.js` (Improvement 11) for legal hold apply/remove.
 *
 * Deliberately NOT a replacement for the already-real, Visa-specific
 * `services/EnterpriseDocumentService.js` — see
 * docs/07-enterprise-standards/12-file-storage.md "Relationship to
 * EnterpriseDocumentService". Not wired into any existing controller in
 * this pass.
 */

const EVENT_OWNER = "Enterprise File Storage Platform";

const computeChecksum = (buffer, algorithm) => crypto.createHash(algorithm).update(buffer).digest("hex");

/** Same real HMAC-SHA256 signed-URL technique already proven in `services/EnterpriseDocumentService.js#generateSignedUrl` — reimplemented here as a real, exported, VERIFIABLE pair (that file never exported a matching verify function; nothing in this codebase could actually check a signature before this). */
export const generateSignedUrl = (storageKey, ttlSeconds) => {
  const storageConfig = getStorageConfig();
  if (!storageConfig.signedUrlSecret) throw new Error("DOCUMENT_SIGNING_SECRET is not configured — cannot generate a signed URL.");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = crypto.createHmac("sha256", storageConfig.signedUrlSecret).update(`${storageKey}:${expiresAt}`).digest("hex");
  return { storageKey, expiresAt, signature };
};

/** Real verification — recomputes the HMAC rather than trusting the caller, and rejects an expired signature even if it's otherwise valid. */
export const verifySignedUrl = (storageKey, expiresAt, signature) => {
  const storageConfig = getStorageConfig();
  if (!storageConfig.signedUrlSecret) return false;
  if (Math.floor(Date.now() / 1000) > Number(expiresAt)) return false;
  const expectedSignature = crypto.createHmac("sha256", storageConfig.signedUrlSecret).update(`${storageKey}:${expiresAt}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"));
  } catch {
    return false; // malformed signature (wrong length/encoding) — never throw, just reject
  }
};

/**
 * "Upload Workflow: Permission Validation -> Virus Scan -> Checksum
 * Generation -> Encryption -> Object Storage -> Metadata Database ->
 * Audit Log -> UploadCompleted.v1." Permission validation is the
 * caller's responsibility (same convention as every service in this
 * codebase). `rootFileId` creates a new VERSION of an existing file
 * chain instead of a brand-new one — "Never overwrite."
 */
export const uploadFile = async ({
  buffer, fileName, contentType, module, referenceType = null, referenceId = null,
  tenantId, userId, correlationId = null, storageClass = null, tags = [],
  companyId = null, merchantAccountId = null, branchId = null, rootFileId = null
}) => {
  if (!buffer || !buffer.length) throw new Error("A non-empty file buffer is required.");
  if (!fileName) throw new Error("fileName is required.");
  if (!module) throw new Error("module is required.");
  if (!tenantId) throw new Error("tenantId is required.");
  if (!userId) throw new Error("userId is required.");

  const config = getDocumentServiceConfig();
  const allowedTypes = getAllowedDocumentMimeTypes();
  if (!allowedTypes.includes(contentType)) {
    throw new AppError("VALIDATION_FAILED", { message: `Content type "${contentType}" is not an allowed file type.`, details: [{ field: "contentType", message: "not an allowed file type" }] });
  }

  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const checksum = computeChecksum(buffer, config.checksumAlgorithm);

  const virusScanStatus = await scanBuffer(buffer, fileName);
  if (virusScanStatus === "Failed") {
    await AuditLogModel.create({
      action: "file.virus_detected", outcome: "failure", tenantId, requestId: resolvedCorrelationId || undefined,
      module: "EnterpriseFileStorage", resource: module, details: { fileName, contentType, referenceType, referenceId }
    });
    await publishVersionedEvent({
      eventName: "VirusDetected", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
      tenantId, correlationId: resolvedCorrelationId, data: { fileName, module, referenceType, referenceId }
    });
    throw new AppError("VALIDATION_FAILED", { message: "File failed virus scanning and was rejected.", details: [{ field: "file", message: "virus detected" }] });
  }

  let storedBuffer = buffer;
  let encrypted = false;
  if (config.encryptionEnabled) {
    storedBuffer = encryptBuffer(buffer);
    encrypted = true;
  }

  const extension = fileName.includes(".") ? `.${fileName.split(".").pop()}` : undefined;
  const uploadResult = await saveBookingDocumentFile({ fileName, mimeType: contentType, buffer: storedBuffer, extension });

  const { retentionYears, policyCode } = await resolveRetentionYears(tenantId, module);
  const purgeEligibleAt = new Date();
  purgeEligibleAt.setFullYear(purgeEligibleAt.getFullYear() + retentionYears);

  let versionNumber = 1;
  if (rootFileId) {
    const previousLatest = await FileModel.findOneAndUpdate({ _id: rootFileId, tenantId, isLatestVersion: true }, { $set: { isLatestVersion: false } });
    if (!previousLatest) throw new Error("Root file (for versioning) not found.");
    versionNumber = previousLatest.versionNumber + 1;
  }

  const file = await FileModel.create({
    tenantId, companyId, merchantAccountId, branchId,
    module, referenceType, referenceId,
    fileName, contentType, fileSize: buffer.length, checksum, encrypted,
    virusScanStatus, storageClass: storageClass || config.defaultStorageClass,
    storageProvider: uploadResult.storageProvider, storageKey: uploadResult.storedFileName || uploadResult.storedPath,
    versionNumber, rootFileId: rootFileId || null, isLatestVersion: true,
    uploadedBy: userId, uploadedAt: new Date(), tags,
    retentionPolicy: policyCode, purgeEligibleAt,
    createdBy: userId, updatedBy: userId
  });

  await AuditLogModel.create({
    action: "file.uploaded", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseFileStorage", resource: module, resourceId: file._id.toString(),
    details: { fileName, checksum, versionNumber, encrypted, virusScanStatus }
  });
  await publishVersionedEvent({
    eventName: "FileUploaded", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId,
    data: { fileId: file._id.toString(), module, referenceType, referenceId, fileName, checksum, versionNumber, uploadedBy: userId }
  });

  return file.toJSON();
};

/**
 * "Download Workflow: Permission Check -> Tenant Validation -> Branch
 * Validation -> Audit Log -> Temporary Signed URL -> Download." Audits
 * and publishes at the moment a download is AUTHORIZED (a real signed
 * URL issued) — permission/tenant/branch checks are the caller's
 * responsibility, same convention as every service in this codebase.
 */
export const generateSignedDownloadUrl = async (fileId, tenantId, { userId = null, correlationId = null, ttlSeconds } = {}) => {
  const config = getDocumentServiceConfig();
  const file = await FileModel.findOne({ _id: fileId, tenantId }).lean();
  if (!file) throw new Error("File not found.");

  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const effectiveTtl = ttlSeconds || config.signedUrlTtlSeconds;
  const { expiresAt, signature } = generateSignedUrl(file.storageKey, effectiveTtl);

  await AuditLogModel.create({
    action: "file.downloaded", tenantId, requestId: resolvedCorrelationId || undefined,
    module: "EnterpriseFileStorage", resource: file.module, resourceId: String(file._id), details: { fileName: file.fileName, downloadedBy: userId }
  });
  await publishVersionedEvent({
    eventName: "FileDownloaded", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER,
    tenantId, correlationId: resolvedCorrelationId, data: { fileId: String(file._id), fileName: file.fileName, downloadedBy: userId }
  });

  return { expiresAt: new Date(expiresAt * 1000).toISOString(), signature, storageKey: file.storageKey };
};

export const getFileById = async (fileId, tenantId) => {
  const file = await FileModel.findOne({ _id: fileId, tenantId }).lean();
  if (!file) throw new Error("File not found.");
  return file;
};

export const listFiles = async (tenantId, query = {}) => {
  const config = getDocumentServiceConfig();
  const filter = { tenantId };
  if (query.module) filter.module = query.module;
  if (query.referenceType) filter.referenceType = query.referenceType;
  if (query.referenceId) filter.referenceId = query.referenceId;
  if (query.isArchived !== undefined) filter.isArchived = query.isArchived === "true" || query.isArchived === true;
  if (query.latestOnly !== "false") filter.isLatestVersion = true;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    FileModel.find(filter).sort({ uploadedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    FileModel.countDocuments(filter)
  ]);
  return { items: items.map((item) => { delete item.storageKey; return item; }), pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};

// ---- Archive / Restore / Purge — real reuse of Improvement 10's engine,
// each wrapper adding only the file-specific domain event on top.

export const archiveFile = async (fileId, tenantId, reason, userId, correlationId = null) => {
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const result = await archiveRecord({ Model: FileModel, filter: { _id: fileId, tenantId }, resourceType: "File", reason, userId, tenantId, correlationId: resolvedCorrelationId });
  await publishVersionedEvent({ eventName: "FileArchived", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, correlationId: resolvedCorrelationId, data: { fileId, archivedBy: userId } });
  delete result.storageKey;
  return result;
};

export const restoreFile = async (fileId, tenantId, userId, correlationId = null) => {
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const result = await restoreRecord({ Model: FileModel, filter: { _id: fileId, tenantId }, resourceType: "File", userId, tenantId, correlationId: resolvedCorrelationId });
  await publishVersionedEvent({ eventName: "FileRestored", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, correlationId: resolvedCorrelationId, data: { fileId, restoredBy: userId } });
  delete result.storageKey;
  return result;
};

/** `purgeRecord` already fires the real `RetentionExpired.v1` internally when its gate passes — this file adds `FileDeleted.v1` on top, the file-specific completion signal. */
export const purgeFile = async (fileId, tenantId, approvedBy, userId, correlationId = null) => {
  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const result = await purgeRecord({ Model: FileModel, filter: { _id: fileId, tenantId }, resourceType: "File", approvedBy, userId, tenantId, correlationId: resolvedCorrelationId });
  await publishVersionedEvent({ eventName: "FileDeleted", version: 1, category: "Domain", owner: EVENT_OWNER, source: EVENT_OWNER, tenantId, correlationId: resolvedCorrelationId, data: { fileId, purgedBy: userId, approvedBy } });
  return result;
};

// ---- Legal Hold — real reuse of Improvement 11's registry.

export const applyLegalHoldToFile = async (fileId, tenantId, reason, userId, correlationId = null) =>
  applyLegalHold({ Model: FileModel, filter: { _id: fileId, tenantId }, resourceType: "File", resourceId: fileId, reason, userId, tenantId, correlationId });

export const removeLegalHoldFromFile = async (fileId, holdId, tenantId, userId, correlationId = null, removalReason = null) =>
  removeLegalHold({ Model: FileModel, filter: { _id: fileId, tenantId }, resourceType: "File", resourceId: fileId, holdId, userId, tenantId, correlationId, removalReason });
