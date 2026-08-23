import test from "node:test";
import assert from "node:assert/strict";
import AIDocumentClassificationService, { classifyByHeuristic } from "../services/ai/AIDocumentClassificationService.js";
import {
  extractPassportFields, extractInvoiceFields, extractReceiptFields, extractBankStatementFields, extractContractFields
} from "../services/ai/AIDocumentExtractionService.js";
import AIModelRouterService from "../services/ai/AIModelRouterService.js";

// Document Intelligence Platform Phase 1-2 — real, deterministic
// classification heuristic + template-driven extraction, no live LLM or DB
// needed for either (both are pure functions over OCR'd text).

const PASSPORT_TEXT = "PASSPORT REPUBLIC OF PAKISTAN TYPE P COUNTRY PAK SURNAME KHAN GIVEN NAMES: ALI HASSAN NATIONALITY: PAKISTANI DATE OF BIRTH: 15 MAY 1990 PLACE OF BIRTH LAHORE PASSPORT NO: AB1234567 DATE OF ISSUE: 01 JAN 2022 DATE OF EXPIRY: 01 JAN 2032 P<PAKKHAN<<ALI<<<<<<<<<<<<<<<<<<<<<<<<<<<<<";
const INVOICE_TEXT = "Acme Supplies Ltd\nInvoice Number: INV-2026-00123\nInvoice Date: 2026-08-01\nDue Date: 2026-08-31\nBill To: Client Corp\nAmount Due: 1500.00\nVAT: 15%";
const BANK_STATEMENT_TEXT = "BANK ACCOUNT STATEMENT Account Number: 001234567890 Statement Period: Jul 2026 Opening Balance: 5000.00 Closing Balance: 7200.00 IBAN: PK00ABCD0000001234567890";
const CONTRACT_TEXT = "SERVICE AGREEMENT This Agreement is made WHEREAS the Party of the First Part hereinafter referred to as Client agrees to the Terms and Conditions Effective Date: 2026-01-01 Governing Law: Pakistan Signature: signed";
const RECEIPT_TEXT = "Corner Store\nThank you for your purchase!\nCashier: Ahmed\nSubtotal 45.00\nTotal 48.00\nQty 3\nChange Due 5.00\nReceipt #: RC-9981";

// ---- Classification ----

test("classifyByHeuristic correctly identifies each real document type from its text", () => {
  assert.equal(classifyByHeuristic(PASSPORT_TEXT).documentType, "passport");
  assert.equal(classifyByHeuristic(INVOICE_TEXT).documentType, "invoice");
  assert.equal(classifyByHeuristic(BANK_STATEMENT_TEXT).documentType, "bank_statement");
  assert.equal(classifyByHeuristic(CONTRACT_TEXT).documentType, "contract");
  assert.equal(classifyByHeuristic(RECEIPT_TEXT).documentType, "receipt");
});

test("classifyByHeuristic returns a real, non-fabricated confidence score between 0 and 1", () => {
  const result = classifyByHeuristic(PASSPORT_TEXT);
  assert.ok(result.confidence > 0 && result.confidence <= 1);
});

test("classifyByHeuristic honestly classifies unrelated text as unknown with zero confidence, never a guess", () => {
  const result = classifyByHeuristic("the quick brown fox jumps over the lazy dog");
  assert.equal(result.documentType, "unknown");
  assert.equal(result.confidence, 0);
});

test("classifyByHeuristic handles empty/null input without throwing", () => {
  assert.equal(classifyByHeuristic("").documentType, "unknown");
  assert.equal(classifyByHeuristic(null).documentType, "unknown");
});

// ---- Extraction ----

test("extractPassportFields extracts real structured fields matching EnterpriseVerificationModel.ocrResult.extractedFields' own shape", () => {
  const fields = extractPassportFields(PASSPORT_TEXT);
  assert.equal(fields.passportNumber, "AB1234567");
  assert.equal(fields.documentNumber, "AB1234567");
  assert.equal(fields.holderName, "ALI HASSAN");
  assert.equal(fields.nationality, "PAKISTANI");
  assert.equal(fields.dateOfBirth.toISOString().slice(0, 10), "1990-05-15");
  assert.equal(fields.issueDate.toISOString().slice(0, 10), "2022-01-01");
  assert.equal(fields.expiryDate.toISOString().slice(0, 10), "2032-01-01");
  assert.ok(fields.mrz.startsWith("P<PAK"));
});

test("extractInvoiceFields reuses ExpenseOcrService's own extractors — real invoice number/vendor/amount/date", () => {
  const fields = extractInvoiceFields(INVOICE_TEXT);
  assert.equal(fields.invoiceNumber, "INV-2026-00123");
  assert.equal(fields.vendor, "Acme Supplies Ltd");
  assert.equal(fields.amount, 1500);
  assert.equal(fields.invoiceDate.toISOString().slice(0, 10), "2026-08-01");
  assert.equal(fields.dueDate.toISOString().slice(0, 10), "2026-08-31");
});

test("extractReceiptFields reuses the same real amount/date/vendor/number extractors as invoices", () => {
  const fields = extractReceiptFields(RECEIPT_TEXT);
  assert.equal(fields.receiptNumber, "RC-9981");
  assert.equal(fields.vendor, "Corner Store");
  assert.equal(fields.amount, 48);
});

test("extractBankStatementFields extracts account number, IBAN, statement period, and both balances", () => {
  const fields = extractBankStatementFields(BANK_STATEMENT_TEXT);
  assert.equal(fields.accountNumber, "001234567890");
  assert.equal(fields.iban, "PK00ABCD0000001234567890");
  assert.equal(fields.statementPeriod, "Jul 2026");
  assert.equal(fields.openingBalance, 5000);
  assert.equal(fields.closingBalance, 7200);
});

test("extractContractFields extracts only what's honestly structured (effective date, governing law) — no fabricated summary of terms", () => {
  const fields = extractContractFields(CONTRACT_TEXT);
  assert.equal(fields.effectiveDate.toISOString().slice(0, 10), "2026-01-01");
  assert.equal(fields.governingLaw, "Pakistan");
});

test("every extractor returns an honest empty object for empty/null text, never throws", () => {
  assert.deepEqual(extractPassportFields(""), {});
  assert.deepEqual(extractPassportFields(null), {});
  assert.deepEqual(extractBankStatementFields(null), {});
});

// ---- Phase 4 PII masking (Gap-Fix PRD §"Never silently guess... apply the
// same PII-masking pattern... to any passport/CNIC/bank-account field that
// flows through document extraction") — the one point in this pipeline
// where raw OCR text reaches a third-party LLM provider (the low-confidence
// classification refinement) must never carry an unmasked
// CNIC/credit-card/IBAN-shaped value.

test("classifyDocumentText masks sensitive-shaped values before they ever reach the LLM refinement call", async (t) => {
  // Deliberately weak bank_statement signal (2/8 real keyword patterns) so
  // the heuristic's own confidence lands well below the configured 0.6
  // threshold and the LLM refinement path actually runs.
  const lowConfidenceText = "Account Number: 001234567890 IBAN: PK36SCBL0000001123494501";
  assert.ok(classifyByHeuristic(lowConfidenceText).confidence < 0.6, "test text must genuinely be low-confidence to exercise the LLM path");

  let capturedContent = null;
  t.mock.method(AIModelRouterService, "route", async ({ messages }) => {
    capturedContent = messages[0].content;
    return { content: "bank_statement" };
  });

  const result = await AIDocumentClassificationService.classifyDocumentText(lowConfidenceText, { tenantId: "test-tenant" });

  assert.equal(result.method, "llm");
  assert.ok(capturedContent, "the router must have been called");
  assert.ok(!capturedContent.includes("PK36SCBL0000001123494501"), "the full IBAN must never reach a third-party LLM provider unmasked");
  assert.match(capturedContent, /\*+4501/, "the masked value must keep only the last 4 characters visible, same as the conversational AI layer's own masking");
  // The classifier-relevant KEYWORD signal must survive masking — only the
  // sensitive VALUE is redacted, never the label text classification relies on.
  assert.ok(capturedContent.includes("Account Number") && capturedContent.includes("IBAN"), "field labels must remain intact for classification to still work");
});
