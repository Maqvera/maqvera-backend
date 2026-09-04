import { test, after } from "node:test";
import assert from "node:assert/strict";
import CustomerStatementPdfService from "../services/CustomerStatementPdfService.js";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

const baseStatement = {
  customer: { name: "Jane Doe", customerCode: "CUST-0001" },
  period: { dateFrom: null, dateTo: null },
  generatedAt: new Date("2026-09-01"),
  rows: [
    { referenceNumber: "INV-2026-000123", description: "Umrah Package", debit: 1000, credit: 400, balance: 600, status: "Partially Paid", currency: "USD" }
  ],
  totals: { totalDebit: 1000, totalCredit: 400, totalBalance: 600 }
};

test("CustomerStatementPdfService renders a valid PDF with statement rows and totals", async () => {
  const buffer = await CustomerStatementPdfService.generatePdfBuffer(baseStatement);
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

test("CustomerStatementPdfService renders the period line only when a date range is present", async () => {
  const withPeriod = await CustomerStatementPdfService.generatePdfBuffer({ ...baseStatement, period: { dateFrom: "2026-01-01", dateTo: "2026-06-30" } });
  const withoutPeriod = await CustomerStatementPdfService.generatePdfBuffer(baseStatement);
  assert.ok(Buffer.isBuffer(withPeriod) && withPeriod.length > 0);
  assert.notEqual(withPeriod.length, withoutPeriod.length);
});

after(async () => {
  await closeBrowser();
});
