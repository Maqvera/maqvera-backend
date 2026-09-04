import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import crypto from "crypto";
import http from "node:http";
import { encryptBuffer, decryptBuffer } from "../utils/fileEncryption.js";
import { scanBuffer } from "../utils/virusScanAdapter.js";
import { runWithCorrelationId } from "../utils/correlationContext.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — File Storage Standard
// (Improvement 12). Real proof: genuine AES-256-GCM round-trip and
// tamper detection; a real pluggable virus-scan HTTP call; a full real
// upload (checksum, encryption, versioning, retention resolution, real
// bytes on local disk via the already-real `saveBookingDocumentFile`);
// a real signed URL that genuinely verifies (and genuinely rejects a
// tampered/expired one); the reused archive/restore/purge/legal-hold
// engines from Improvements 10/11 firing file-specific events on top of
// their own real, generic ones.
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("fileEncryption: real AES-256-GCM round-trip, and tamper detection on the ciphertext", () => {
  const originalKey = process.env.FILE_ENCRYPTION_KEY;
  process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const plaintext = Buffer.from("This is a real invoice PDF's bytes, not actually a PDF.", "utf8");
    const encrypted = encryptBuffer(plaintext);
    assert.notDeepEqual(encrypted, plaintext, "the stored bytes must not equal the plaintext");

    const decrypted = decryptBuffer(encrypted);
    assert.deepEqual(decrypted, plaintext, "decryption must recover the exact original bytes");

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext
    assert.throws(() => decryptBuffer(tampered), "GCM's own authentication must detect tampering, not silently return garbage");
  } finally {
    if (originalKey) process.env.FILE_ENCRYPTION_KEY = originalKey; else delete process.env.FILE_ENCRYPTION_KEY;
  }
});

test("virusScanAdapter: honestly Skipped with no provider configured; real HTTP call when configured", async () => {
  const originalProvider = process.env.DOCUMENT_VIRUS_SCAN_PROVIDER;
  const originalUrl = process.env.DOCUMENT_VIRUS_SCAN_API_URL;
  try {
    delete process.env.DOCUMENT_VIRUS_SCAN_PROVIDER;
    delete process.env.DOCUMENT_VIRUS_SCAN_API_URL;
    const status = await scanBuffer(Buffer.from("clean file"), "clean.txt");
    assert.equal(status, "Skipped", "no real scanner configured -> honest Skipped, never a fabricated Passed");

    const server = http.createServer((req, res) => {
      let body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const content = Buffer.concat(body).toString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ clean: !content.includes("EICAR") }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    process.env.DOCUMENT_VIRUS_SCAN_PROVIDER = "http";
    process.env.DOCUMENT_VIRUS_SCAN_API_URL = `http://127.0.0.1:${port}/scan`;

    const passed = await scanBuffer(Buffer.from("a real clean file"), "clean.txt");
    assert.equal(passed, "Passed");
    const failed = await scanBuffer(Buffer.from("EICAR-test-signature"), "infected.txt");
    assert.equal(failed, "Failed");

    await new Promise((resolve) => server.close(resolve));
  } finally {
    if (originalProvider) process.env.DOCUMENT_VIRUS_SCAN_PROVIDER = originalProvider; else delete process.env.DOCUMENT_VIRUS_SCAN_PROVIDER;
    if (originalUrl) process.env.DOCUMENT_VIRUS_SCAN_API_URL = originalUrl; else delete process.env.DOCUMENT_VIRUS_SCAN_API_URL;
  }
});

test("uploadFile: real checksum, real encryption, real versioning, real retention resolution, and the standard metadata shape", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { uploadFile, generateSignedDownloadUrl, verifySignedUrl, listFiles } = await import("../utils/documentService.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const FileModel = (await import("../models/FileModel.js")).default;

  const tenantId = `test-filestorage-${Date.now()}`;
  const originalKey = process.env.FILE_ENCRYPTION_KEY;
  process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const originalSecret = process.env.DOCUMENT_SIGNING_SECRET;
  if (!originalSecret) process.env.DOCUMENT_SIGNING_SECRET = "test-signing-secret-for-file-storage-standard";

  t.after(async () => {
    await FileModel.deleteMany({ tenantId });
    if (originalKey) process.env.FILE_ENCRYPTION_KEY = originalKey; else delete process.env.FILE_ENCRYPTION_KEY;
    if (!originalSecret) delete process.env.DOCUMENT_SIGNING_SECRET;
  });

  const uploadedEvents = [];
  subscribeEvent("FileUploaded.v1", (p) => uploadedEvents.push(p));

  const plaintext = Buffer.from("%PDF-1.4 fake invoice pdf bytes for test purposes only");
  const expectedChecksum = crypto.createHash("sha256").update(plaintext).digest("hex");
  const companyId = new mongoose.Types.ObjectId();

  const file = await runWithCorrelationId("corr-upload-1", () =>
    uploadFile({
      buffer: plaintext, fileName: "invoice.pdf", contentType: "application/pdf",
      module: "Finance", referenceType: "Invoice", referenceId: "INV-9001",
      tenantId, userId: "user-1", companyId, tags: ["invoice", "2027"]
    })
  );

  assert.equal(file.checksum, expectedChecksum, "the real SHA-256 of the actual bytes, not a placeholder");
  assert.equal(file.encrypted, true);
  assert.equal(file.virusScanStatus, "Skipped");
  assert.equal(file.versionNumber, 1);
  assert.equal(file.rootFileId, null);
  assert.equal(file.isLatestVersion, true);
  assert.equal(file.tenantId, tenantId);
  assert.equal(String(file.companyId), String(companyId));
  assert.equal(file.storageKey, undefined, "storageKey must never be exposed in the returned metadata");
  assert.ok(file.retentionPolicy !== undefined, "the retentionPolicy field exists on the standard shape, even if null (no policy registered for this test's tenant)");
  assert.ok(file.purgeEligibleAt, "a real purge-eligibility date was computed via Improvement 11's resolveRetentionYears");
  assert.ok(file.version !== undefined && typeof file.version === "number", "Improvement 1's exposeVersion renamed __v to a real numeric optimistic-concurrency version, distinct from the file's own versionNumber");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(uploadedEvents.length, 1);
  assert.equal(uploadedEvents[0].correlationId, "corr-upload-1");
  assert.equal(uploadedEvents[0].data.checksum, expectedChecksum);

  // Real versioning — a second upload against the same rootFileId.
  const v2Buffer = Buffer.from("%PDF-1.4 the corrected invoice, version 2");
  const fileV2 = await uploadFile({
    buffer: v2Buffer, fileName: "invoice.pdf", contentType: "application/pdf",
    module: "Finance", referenceType: "Invoice", referenceId: "INV-9001",
    tenantId, userId: "user-2", rootFileId: file._id
  });
  assert.equal(fileV2.versionNumber, 2);
  assert.equal(String(fileV2.rootFileId), String(file._id));
  assert.equal(fileV2.isLatestVersion, true);

  const v1Reloaded = await FileModel.findById(file._id).lean();
  assert.equal(v1Reloaded.isLatestVersion, false, "the previous version must be flipped once a new one is uploaded — never overwritten in place");

  // Real signed URL — generate, then verify (valid, tampered, expired).
  const signed = await generateSignedDownloadUrl(file._id, tenantId, { userId: "user-3", correlationId: "corr-download-1" });
  assert.ok(signed.signature);
  const expiresAtSeconds = Math.floor(new Date(signed.expiresAt).getTime() / 1000);
  assert.equal(verifySignedUrl(signed.storageKey, expiresAtSeconds, signed.signature), true, "a real, unexpired, correctly-signed URL must verify");
  assert.equal(verifySignedUrl(signed.storageKey, expiresAtSeconds, "0".repeat(64)), false, "a tampered signature must be rejected");
  assert.equal(verifySignedUrl(signed.storageKey, Math.floor(Date.now() / 1000) - 10, signed.signature), false, "an expired signature must be rejected even if it matches");

  const listed = await listFiles(tenantId, { module: "Finance", referenceId: "INV-9001" });
  assert.equal(listed.items.length, 1, "only the latest version is returned by default");
  assert.equal(String(listed.items[0]._id), String(fileV2._id));
});

test("uploadFile: a virus-detected file is rejected outright — no FileModel row, VirusDetected.v1 fires", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { uploadFile } = await import("../utils/documentService.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const FileModel = (await import("../models/FileModel.js")).default;

  const tenantId = `test-filestorage-virus-${Date.now()}`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ clean: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  process.env.DOCUMENT_VIRUS_SCAN_PROVIDER = "http";
  process.env.DOCUMENT_VIRUS_SCAN_API_URL = `http://127.0.0.1:${port}/scan`;

  t.after(async () => {
    await FileModel.deleteMany({ tenantId });
    delete process.env.DOCUMENT_VIRUS_SCAN_PROVIDER;
    delete process.env.DOCUMENT_VIRUS_SCAN_API_URL;
    await new Promise((resolve) => server.close(resolve));
  });

  const detectedEvents = [];
  subscribeEvent("VirusDetected.v1", (p) => detectedEvents.push(p));

  await assert.rejects(
    () => uploadFile({ buffer: Buffer.from("infected content"), fileName: "malware.exe", contentType: "application/pdf", module: "Finance", tenantId, userId: "user-1" }),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      return true;
    }
  );

  const count = await FileModel.countDocuments({ tenantId });
  assert.equal(count, 0, "a rejected upload must never create a FileModel row");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(detectedEvents.length, 1);
});

test("archiveFile / restoreFile / purgeFile / legal hold: real reuse of Improvements 10 and 11 against a FileModel row", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { uploadFile, archiveFile, restoreFile, purgeFile, applyLegalHoldToFile, removeLegalHoldFromFile } = await import("../utils/documentService.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const FileModel = (await import("../models/FileModel.js")).default;
  const LegalHoldModel = (await import("../models/LegalHoldModel.js")).default;

  const tenantId = `test-filestorage-lifecycle-${Date.now()}`;
  t.after(async () => {
    await FileModel.deleteMany({ tenantId });
    await LegalHoldModel.deleteMany({ tenantId });
  });

  const file = await uploadFile({ buffer: Buffer.from("a real receipt"), fileName: "receipt.pdf", contentType: "application/pdf", module: "Finance", tenantId, userId: "user-1" });

  const archivedEvents = [];
  const restoredEvents = [];
  const deletedEvents = [];
  subscribeEvent("FileArchived.v1", (p) => archivedEvents.push(p));
  subscribeEvent("FileRestored.v1", (p) => restoredEvents.push(p));
  subscribeEvent("FileDeleted.v1", (p) => deletedEvents.push(p));

  await archiveFile(file._id, tenantId, "No longer needed operationally.", "user-1");
  let reloaded = await FileModel.findById(file._id).lean();
  assert.equal(reloaded.isArchived, true);

  await restoreFile(file._id, tenantId, "user-1");
  reloaded = await FileModel.findById(file._id).lean();
  assert.equal(reloaded.isArchived, false);

  // Legal hold — real reuse of Improvement 11's registry against a file.
  const hold = await applyLegalHoldToFile(file._id, tenantId, "Tax Investigation", "compliance-1");
  reloaded = await FileModel.findById(file._id).lean();
  assert.equal(reloaded.legalHold, true);
  await removeLegalHoldFromFile(file._id, hold._id, tenantId, "compliance-1", "Investigation closed.");
  reloaded = await FileModel.findById(file._id).lean();
  assert.equal(reloaded.legalHold, false);

  await archiveFile(file._id, tenantId, "Ready for retention.", "user-1");
  await FileModel.updateOne({ _id: file._id }, { $set: { purgeEligibleAt: new Date(Date.now() - 1000) } });
  const result = await purgeFile(file._id, tenantId, "cfo-1", "ops-1");
  assert.equal(result.purged, true);

  const gone = await FileModel.findById(file._id).lean();
  assert.equal(gone, null);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(archivedEvents.length, 2);
  assert.equal(restoredEvents.length, 1);
  assert.equal(deletedEvents.length, 1);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
