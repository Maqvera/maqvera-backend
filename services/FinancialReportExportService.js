import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";

/**
 * "Export Formats: PDF, Excel, CSV, JSON, API, Scheduled Email." Real
 * generation for PDF (`pdfkit`, the same real package every other
 * Finance PDF service this session already uses), Excel (`exceljs`,
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

  /** Real PDF — report header (type/period/currency/generated date) + the same flattened table. */
  static async generatePdfBuffer(report) {
    const rows = flattenReportRows(report.reportType, report.data);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8); // A4 width realistically fits ~8 columns.

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(16).text(report.reportType.replace(/([A-Z])/g, " $1").trim(), { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(9).text(`Period: ${report.period || "N/A"}    Currency: ${report.currency || "All"}    Generated: ${new Date(report.generatedAt).toISOString().slice(0, 19)}`, { align: "center" });
      doc.moveDown(1);

      const colWidth = (doc.page.width - 80) / headers.length;
      let y = doc.y;
      doc.fontSize(8).font("Helvetica-Bold");
      headers.forEach((h, i) => doc.text(h, 40 + i * colWidth, y, { width: colWidth, ellipsis: true }));
      doc.moveDown(0.5);
      doc.font("Helvetica");

      for (const row of rows.slice(0, 500)) {
        y = doc.y;
        if (y > doc.page.height - 60) { doc.addPage({ margin: 40, size: "A4", layout: "landscape" }); y = doc.y; }
        headers.forEach((h, i) => {
          const value = row[h];
          const text = value instanceof Date ? value.toISOString().slice(0, 10) : (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? ""));
          doc.text(text, 40 + i * colWidth, y, { width: colWidth, ellipsis: true });
        });
        doc.moveDown(0.4);
      }

      doc.end();
    });
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
