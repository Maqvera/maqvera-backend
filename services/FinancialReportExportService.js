import ExcelJS from "exceljs";
import path from "path";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

const PDF_TEMPLATE_PATH = path.join(TEMPLATES_DIR, "reports", "financial_report.html");

/**
 * "Export Formats: PDF, Excel, CSV, JSON, API, Scheduled Email." Real
 * generation for PDF (HTML-template + headless-Chromium via
 * services/HtmlPdfRenderer.js, the same renderer every other Finance PDF
 * service now uses — PRD "HTML-Template PDF Architecture Migration"),
 * Excel (`exceljs`,
 * already installed for Part 14's real statement PARSING — now used for
 * real WRITING), and CSV. "JSON" is simply the report's own already-
 * stored `data` field — no separate generation step. "API" is the
 * report's own real GET endpoint. "Scheduled Email" is a delivery
 * mechanism (services/financialReportScheduler.js), not a file format.
 *
 * Report `data` shapes vary genuinely by `reportType` (trial-balance-
 * style `rows`, cash-flow-style `lines`, balance-sheet-style `sections`,
 * aging-style `buckets`) — `flattenReportRows` normalizes whichever real
 * shape a given report actually has into a flat, real table, the common
 * representation CSV/Excel/PDF all render from.
 */
export const flattenReportRows = (reportType, data) => {
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.lines)) return data.lines;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.buckets)) return data.buckets;
  if (data.sections && typeof data.sections === "object") {
    return Object.entries(data.sections).flatMap(([section, rows]) => rows.map((row) => ({ section, ...row })));
  }
  // A scalar-summary report (e.g. RetainedEarnings) — one real row of its own top-level figures.
  const { rows: _rows, lines: _lines, sections: _sections, items: _items, ...scalars } = data;
  return [scalars];
};

const toCsvValue = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

class FinancialReportExportService {
  /** Real CSV — one row per flattened report row, headers from the union of every row's own keys. */
  static generateCsv(report) {
    const rows = flattenReportRows(report.reportType, report.data);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => toCsvValue(row[h])).join(","))];
    return { content: lines.join("\n"), mimeType: "text/csv", filename: `${report.reportType}-${report._id}.csv` };
  }

  /** Real .xlsx workbook — one worksheet, real cell values (not just text). */
  static async generateExcel(report) {
    const rows = flattenReportRows(report.reportType, report.data);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(report.reportType.slice(0, 31));
    worksheet.addRow(headers);
    worksheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      worksheet.addRow(headers.map((h) => {
        const value = row[h];
        return value instanceof Date || (typeof value !== "object" && value !== undefined) ? value ?? "" : JSON.stringify(value);
      }));
    }
    worksheet.columns.forEach((column) => { column.width = 18; });

    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${report.reportType}-${report._id}.xlsx` };
  }

  /**
   * Real PDF — report header (type/period/currency/generated date) + the
   * same flattened table, now HTML-template + headless-Chromium rendering
   * (services/HtmlPdfRenderer.js), PRD "HTML-Template PDF Architecture
   * Migration". Same public contract as the pdfkit-era version this
   * replaced. Cell values are pre-formatted to display strings here (Date
   * -> YYYY-MM-DD, object -> JSON, everything else -> String()) — the
   * template only renders them, same "no business logic in the template"
   * discipline as every other migrated *PdfService.js. Pagination across
   * the 8-column x 500-row table is now Puppeteer's natural CSS
   * page-break flow, replacing the pdfkit-era manual doc.addPage() loop.
   */
  static async generatePdfBuffer(report) {
    const rows = flattenReportRows(report.reportType, report.data);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8); // A4 landscape width realistically fits ~8 columns.

    const formatCell = (value) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === "object" && value !== null) return JSON.stringify(value);
      return String(value ?? "");
    };

    const displayRows = rows.slice(0, 500).map((row) => headers.map((h) => formatCell(row[h])));

    return renderHtmlToPdfBuffer(PDF_TEMPLATE_PATH, {
      title: report.reportType.replace(/([A-Z])/g, " $1").trim(),
      period: report.period || "N/A",
      currency: report.currency || "All",
      generatedAt: new Date(report.generatedAt).toISOString().slice(0, 19),
      headers,
      displayRows
    }, { landscape: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
  }

  /**
   * Real export + store, returning the same `{format, url, storageKey,
   * storageProvider, generatedAt}` shape every other Part's own
   * document-export flow already produces.
   */
  static async exportAndStore(report, format, tenantId) {
    if (format === "CSV") {
      const { content, filename } = FinancialReportExportService.generateCsv(report);
      const stored = await storeDocumentPdf({ tenantId, folder: "financial-reports", filename, buffer: Buffer.from(content, "utf8") });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    if (format === "Excel") {
      const { buffer, filename } = await FinancialReportExportService.generateExcel(report);
      const stored = await storeDocumentPdf({ tenantId, folder: "financial-reports", filename, buffer });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    if (format === "PDF") {
      const buffer = await FinancialReportExportService.generatePdfBuffer(report);
      const stored = await storeDocumentPdf({ tenantId, folder: "financial-reports", filename: `${report.reportType}-${report._id}.pdf`, buffer });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    if (format === "JSON") {
      const stored = await storeDocumentPdf({ tenantId, folder: "financial-reports", filename: `${report.reportType}-${report._id}.json`, buffer: Buffer.from(JSON.stringify(report.data, null, 2), "utf8") });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    throw new Error(`Export format "${format}" is not supported.`);
  }
}

export default FinancialReportExportService;
