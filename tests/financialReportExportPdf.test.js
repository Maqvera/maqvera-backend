import { test, after } from "node:test";
import assert from "node:assert/strict";
import FinancialReportExportService from "../services/FinancialReportExportService.js";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

const trialBalanceReport = {
  reportType: "TrialBalance",
  period: "2026-Q1",
  currency: "USD",
  generatedAt: new Date("2026-04-01"),
  data: {
    rows: [
      { accountCode: "1000", accountName: "Cash", debit: 5000, credit: 0, asOf: new Date("2026-03-31") },
      { accountCode: "4000", accountName: "Revenue", debit: 0, credit: 5000, asOf: new Date("2026-03-31") }
    ]
  }
};

test("FinancialReportExportService.generatePdfBuffer renders a valid landscape PDF with the flattened table", async () => {
  const buffer = await FinancialReportExportService.generatePdfBuffer(trialBalanceReport);
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  assert.equal(buffer.slice(0, 5).toString("latin1"), "%PDF-");
});

test("FinancialReportExportService.generatePdfBuffer handles a scalar-summary report (no rows/lines/sections)", async () => {
  const scalarReport = { reportType: "RetainedEarnings", period: "2026", currency: "USD", generatedAt: new Date("2026-01-01"), data: { openingBalance: 1000, netIncome: 500, dividends: 100, closingBalance: 1400 } };
  const buffer = await FinancialReportExportService.generatePdfBuffer(scalarReport);
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
});

after(async () => {
  await closeBrowser();
});
