import test, { after } from "node:test";
import assert from "node:assert/strict";
import ReportExportService, { flattenReportRows } from "../services/ReportExportService.js";
import FinancialReportExportService from "../services/FinancialReportExportService.js";
import { closeBrowser } from "../services/HtmlPdfRenderer.js";

const travelDashboardReport = {
  reportType: "TravelWorkloadDashboard",
  data: { rows: [{ region: "North", openBookings: 12 }, { region: "South", openBookings: 7 }] },
  generatedAt: new Date("2026-01-01T00:00:00Z"),
  _id: "DASH-1"
};

test("ReportExportService.generateCsv — module-agnostic: works for a non-Finance report shape (a Travel dashboard export)", () => {
  const { content, mimeType, filename } = ReportExportService.generateCsv(travelDashboardReport);
  assert.equal(mimeType, "text/csv");
  assert.match(content, /region,openBookings/);
  assert.match(content, /North,12/);
  assert.match(filename, /^TravelWorkloadDashboard-DASH-1\.csv$/);
});

test("ReportExportService.generateExcel — module-agnostic: real .xlsx workbook for a non-Finance report", async () => {
  const { buffer, mimeType } = await ReportExportService.generateExcel(travelDashboardReport);
  assert.equal(mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(buffer.length > 0);
});

test("ReportExportService.exportAndStore — a module-supplied 'folder' (e.g. 'travel-reports') is honored, not hardcoded to Finance's own storage location", async () => {
  const result = await ReportExportService.exportAndStore(travelDashboardReport, "CSV", "TENANT-TEST-REPORTEXPORT-001", { folder: "travel-reports" });
  assert.equal(result.format, "CSV");
  assert.ok(result.url);
  assert.ok(result.storageKey.includes("travel-reports"), `expected storageKey to reflect the custom folder, got "${result.storageKey}"`);
});

test("FinancialReportExportService — backward-compatible wrapper still produces identical output for existing Finance callers", () => {
  const financeReport = { reportType: "TrialBalance", data: { rows: [{ accountCode: "1000", debitBalance: 500 }] }, _id: "RPT-1" };
  const legacy = FinancialReportExportService.generateCsv(financeReport);
  const generic = ReportExportService.generateCsv(financeReport);
  assert.deepEqual(legacy, generic);
});

test("flattenReportRows — re-exported from ReportExportService, same normalization for all real shapes", () => {
  assert.deepEqual(flattenReportRows("X", { rows: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(flattenReportRows("X", { lines: [{ b: 2 }] }), [{ b: 2 }]);
  assert.deepEqual(flattenReportRows("X", { totalRevenue: 100, totalExpense: 40 }), [{ totalRevenue: 100, totalExpense: 40 }]);
});

test("ReportExportService.generatePdfBuffer — a tenantId with no matching DB template (or no live DB) falls back to the file-based template unchanged", async () => {
  const buffer = await ReportExportService.generatePdfBuffer(travelDashboardReport, { tenantId: "TENANT-TEST-REPORTEXPORT-001" });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  assert.equal(buffer.slice(0, 5).toString("latin1"), "%PDF-");
});

after(async () => {
  await closeBrowser();
});
