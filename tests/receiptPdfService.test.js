import { test, after } from "node:test";
import assert from "node:assert/strict";
import ReceiptPdfService from "../services/ReceiptPdfService.js";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

const baseReceipt = {
  receiptNumber: "RCT-2026-000001",
  template: "Travel",
  issueDate: new Date("2026-09-01"),
  amount: 500,
  currency: "USD",
  paymentNumber: "PAY-000001",
  partyName: "Jane Doe"
};

test("ReceiptPdfService renders a valid PDF without company/allocations/qr", async () => {
  const buffer = await ReceiptPdfService.generatePdfBuffer({ ...baseReceipt });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

test("ReceiptPdfService renders allocations and embeds a QR PNG as a data URI (no network fetch needed)", async () => {
  const onePxPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const withQr = await ReceiptPdfService.generatePdfBuffer({
    ...baseReceipt,
    allocations: [{ targetType: "Invoice", targetId: "inv-1", amount: 500 }],
    qrPngBuffer: onePxPng,
    company: { name: "Maqvera Travel", vatNumber: "VAT123" }
  });
  const withoutQr = await ReceiptPdfService.generatePdfBuffer({ ...baseReceipt });

  assert.ok(Buffer.isBuffer(withQr) && withQr.length > 0);
  assert.ok(withQr.length > withoutQr.length, "embedding the QR image + allocations must produce a larger PDF");
});

after(async () => {
  await closeBrowser();
});
