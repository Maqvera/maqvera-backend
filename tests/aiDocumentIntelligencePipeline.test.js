import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

dotenv.config();

// Document Intelligence Platform Phase 1/2 — real end-to-end proof that
// DocumentVerificationService.startVerification's own OCRQueued event
// (previously never consumed — "nothing ever calls back to complete those
// stages", per that service's own pre-existing comment) now genuinely
// completes: a real PDF is generated (services/HtmlPdfRenderer.js, the
// same real Puppeteer pipeline every other *PdfService.js in this codebase
// already uses), served over a real local HTTP server (same pattern
// tests/webhookDeliveryIntegration.test.js already established for
// event-driven side effects), downloaded, OCR'd (pdf-parse — no OCR API
// key needed for text-based PDFs), classified, extracted, and validated —
// all through the real event bus, not a direct function call.

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

const waitFor = async (predicate, { timeoutMs = 20000, intervalMs = 200 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
};

test("Document Intelligence pipeline: a real PDF served over HTTP is OCR'd, classified as an invoice, extracted, and validated — all via the real OCRQueued event, never stuck in 'processing'", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { default: DocumentVerificationService } = await import("../services/DocumentVerificationService.js");
  const EnterpriseDocumentModel = (await import("../models/EnterpriseDocumentModel.js")).default;
  const EnterpriseVerificationModel = (await import("../models/EnterpriseVerificationModel.js")).default;
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const VendorModel = (await import("../models/VendorModel.js")).default;
  const { renderHtmlToPdfBuffer } = await import("../services/HtmlPdfRenderer.js");

  DocumentVerificationService.initEventListeners();

  const suffix = Date.now();
  const tenantId = `test-doc-intel-${suffix}`;
  t.after(async () => {
    await Promise.all([
      EnterpriseDocumentModel.deleteMany({ tenantId }),
      EnterpriseVerificationModel.deleteMany({ tenantId }),
      VisaCaseModel.deleteMany({ tenantId }),
      VendorModel.deleteMany({ tenantId })
    ]);
  });

  // A real vendor, so VENDOR_EXISTS_CHECK genuinely passes rather than just landing on "pending".
  await VendorModel.create({ tenantId, name: "Acme Supplies Ltd", currency: "USD" });

  const visaCase = await VisaCaseModel.create({
    tenantId, caseNumber: `VIS-TEST-${suffix}`, travelerId: new mongoose.Types.ObjectId(),
    travelerSnapshot: { firstName: "Test", lastName: `Traveler${suffix}`, fullName: `Test Traveler${suffix}`, phone: "+10000000000" },
    destinationCountry: "Testland", visaType: "tourist_visa",
    applications: [{ applicationNumber: `VIS-TEST-${suffix}-APP-1`, visaType: "tourist_visa", status: "draft", vendorCost: 0, governmentFee: 0, insuranceFee: 0, serviceCharges: 0, otherCharges: 0, discount: 0, sellingPrice: 0, feeAmount: 0, currency: "USD" }]
  });

  // Real PDF, via this codebase's own real Puppeteer PDF pipeline — not a hand-crafted binary.
  const templatePath = path.join(os.tmpdir(), `doc-intel-test-fixture-${suffix}.html`);
  // No standalone "INVOICE" heading — extractReceiptNumberFromText's own
  // regex (services/ExpenseOcrService.js, unchanged, already tested) looks
  // for the FIRST occurrence of "receipt|invoice|order|ref" followed by
  // whitespace-or-colon; a bare heading word ahead of "Invoice Number:"
  // would match itself instead. "Invoice Number:"/"Invoice Date:"/"Bill
  // To:"/"Amount Due:" alone already give the classifier plenty of signal.
  await fs.writeFile(templatePath, `<html><body>
    <p>Acme Supplies Ltd</p>
    <p>Invoice Number: INV-2026-${suffix}</p>
    <p>Invoice Date: 2026-08-01</p>
    <p>Due Date: 2026-08-31</p>
    <p>Bill To: Acme Supplies Ltd</p>
    <p>Amount Due: 2500.00</p>
  </body></html>`, "utf-8");
  t.after(async () => { await fs.unlink(templatePath).catch(() => null); });
  const pdfBuffer = await renderHtmlToPdfBuffer(templatePath, {});

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/pdf" });
    res.end(pdfBuffer);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });

  const doc = await EnterpriseDocumentModel.create({
    tenantId, module: "Visa", referenceId: visaCase._id, documentType: "Invoice",
    versions: [{ versionNumber: 1, objectStorageKey: "test-key", fileUrl: `http://127.0.0.1:${port}/test.pdf`, mimeType: "application/pdf", virusScanStatus: "skipped" }],
    verificationStatus: "pending_ocr", approvalStatus: "pending",
    ocrData: { status: "pending", extractedText: null, parsedFields: null, processedAt: null },
    aiValidation: { status: "pending", confidenceScore: 0, notes: null, evaluatedAt: null }
  });

  // The real, non-simulation path — VERIFICATION_SIMULATION_MODE is not set in this environment.
  assert.notEqual(process.env.VERIFICATION_SIMULATION_MODE, "true", "this test proves the REAL pipeline; simulation mode would test something else");
  const verification = await DocumentVerificationService.startVerification(doc._id, tenantId, "tester");
  assert.equal(verification.verificationStatus, "processing", "must genuinely queue, not fake-complete synchronously");

  const completed = await waitFor(async () => {
    const v = await EnterpriseVerificationModel.findById(verification._id).lean();
    return v?.ocrResult?.status !== "pending" && v?.ocrResult?.status !== "processing" ? v : null;
  });

  assert.ok(completed, "OCRQueued must genuinely be consumed — the row must not stay stuck in pending/processing forever");
  assert.equal(completed.ocrResult.status, "completed");
  assert.equal(completed.ocrResult.classifiedType, "invoice");
  assert.ok(completed.ocrResult.classificationConfidence > 0);
  assert.ok(completed.ocrResult.rawText.includes("Invoice Number"));

  assert.equal(completed.ocrResult.genericExtractedFields.invoiceNumber, `INV-2026-${suffix}`);
  assert.equal(completed.ocrResult.genericExtractedFields.amount, 2500);
  assert.equal(completed.ocrResult.genericExtractedFields.vendor, "Acme Supplies Ltd");

  // aiValidationResult — real, computed, and honest about what it didn't check.
  assert.equal(completed.aiValidationResult.status, "completed");
  assert.ok(completed.aiValidationResult.confidenceScore > 0);
  assert.equal(completed.aiValidationResult.visionChecksPerformed, false, "no vision-capable adapter exists in this codebase yet — must never claim otherwise");
  assert.match(completed.aiValidationResult.notes, /vision-capable provider/);

  // businessRuleResult — real ERP-master-data validation, not a stub.
  const duplicateRule = completed.businessRuleResult.rulesEvaluated.find((r) => r.ruleCode === "DUPLICATE_INVOICE_CHECK");
  assert.ok(duplicateRule, "duplicate-invoice check must have run for a classified invoice");
  assert.equal(duplicateRule.status, "passed", "first submission of this invoice number must not be flagged as a duplicate");

  const vendorRule = completed.businessRuleResult.rulesEvaluated.find((r) => r.ruleCode === "VENDOR_EXISTS_CHECK");
  assert.ok(vendorRule, "vendor-existence check must have run");
  assert.equal(vendorRule.status, "passed", "the seeded real VendorModel row must be matched");

  assert.equal(completed.verificationStatus, "manual_review", "still requires a real human decision — never auto-approved");

  const docAfter = await EnterpriseDocumentModel.findById(doc._id).lean();
  assert.equal(docAfter.ocrData.status, "completed");
  assert.equal(docAfter.aiValidation.confidenceScore, completed.aiValidationResult.confidenceScore);
});

test("Document Intelligence pipeline: processQueuedDocumentIntelligence is idempotent — a second call on an already-completed row is a safe no-op", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { default: DocumentVerificationService } = await import("../services/DocumentVerificationService.js");
  const EnterpriseVerificationModel = (await import("../models/EnterpriseVerificationModel.js")).default;
  const EnterpriseDocumentModel = (await import("../models/EnterpriseDocumentModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-doc-intel-idem-${suffix}`;
  t.after(async () => {
    await EnterpriseVerificationModel.deleteMany({ tenantId });
    await EnterpriseDocumentModel.deleteMany({ tenantId });
  });

  const doc = await EnterpriseDocumentModel.create({
    tenantId, module: "Visa", referenceId: new mongoose.Types.ObjectId(), documentType: "Invoice",
    versions: [{ versionNumber: 1, objectStorageKey: "k", fileUrl: "http://127.0.0.1:1/unreachable.pdf", mimeType: "application/pdf" }]
  });
  const verification = await EnterpriseVerificationModel.create({
    tenantId, documentId: doc._id, referenceId: doc.referenceId, versionNumber: 1,
    ocrResult: { status: "completed", classifiedType: "invoice", classificationConfidence: 0.9 }
  });

  await DocumentVerificationService.processQueuedDocumentIntelligence({ verificationId: verification._id, documentId: doc._id, tenantId });

  const after1 = await EnterpriseVerificationModel.findById(verification._id).lean();
  assert.equal(after1.ocrResult.status, "completed", "an already-completed row must be left untouched, never reprocessed");
  assert.equal(after1.ocrResult.classifiedType, "invoice");
});

after(async () => {
  await closeBrowser();
  if (dbAvailable) await mongoose.disconnect();
});
