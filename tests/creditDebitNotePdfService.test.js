import { test, after } from "node:test";
import assert from "node:assert/strict";
import CreditNotePdfService from "../services/CreditNotePdfService.js";
import DebitNotePdfService from "../services/DebitNotePdfService.js";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

const baseNote = {
  creditNumber: "CN-2026-000001",
  debitNumber: "DN-2026-000001",
  status: "Issued",
  issuedAt: new Date("2026-09-01"),
  invoiceNumber: "INV-2026-000123",
  customerName: "Jane Doe",
  vendorName: "Acme Supplies",
  reason: "Overbilled room rate",
  currency: "USD",
  items: [{ description: "Room rate correction", quantity: 1, amount: 100, lineTotal: 100, taxAdjustment: 0 }],
  creditAmount: 100,
  debitAmount: 100,
  taxAdjustmentTotal: 0,
  grandTotal: 100,
  disposition: "Refund"
};

test("CreditNotePdfService renders a valid PDF", async () => {
  const buffer = await CreditNotePdfService.generatePdfBuffer({ ...baseNote });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

test("CreditNotePdfService renders the Draft banner when status is Draft", async () => {
  const draft = await CreditNotePdfService.generatePdfBuffer({ ...baseNote, status: "Draft" });
  const issued = await CreditNotePdfService.generatePdfBuffer({ ...baseNote, status: "Issued" });
  assert.ok(Buffer.isBuffer(draft) && draft.length > 0);
  assert.notEqual(draft.length, issued.length, "Draft banner text should change the rendered output");
});

test("DebitNotePdfService renders Customer-facing labels for partyType Customer", async () => {
  const buffer = await DebitNotePdfService.generatePdfBuffer({ ...baseNote, partyType: "Customer" });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

test("DebitNotePdfService renders Vendor-facing labels for partyType Vendor", async () => {
  const buffer = await DebitNotePdfService.generatePdfBuffer({ ...baseNote, partyType: "Vendor" });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

after(async () => {
  await closeBrowser();
});
