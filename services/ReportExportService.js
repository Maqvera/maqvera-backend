import ExcelJS from "exceljs";
import path from "path";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { renderHtmlToPdfBuffer, renderHtmlStringToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";
import { maskSensitiveColumns } from "../utils/reportColumnSecurity.js";
import ReportTemplateService from "./ReportTemplateService.js";

const DEFAULT_PDF_TEMPLATE_PATH = path.join(TEMPLATES_DIR, "reports", "financial_report.html");
const DEFAULT_STORAGE_FOLDER = "reports";

/**
 * Reporting Platform (Part 9) — "one rendering pipeline (PDF/Excel/CSV/
 * JSON/HTML), shared across all report types," extracted from
 * FinancialReportExportService.js (Finance Module Part 24) rather than
 * rewritten: `generateCsv`/`generateExcel` were already genuinely
 * module-agnostic (confirmed — TenantSubscriptionController.js already
 * reuses them for the Operations Dashboard export, a non-Finance report).
 * Only `generatePdfBuffer`/`exportAndStore` were coupled to Finance via a
 * hardcoded template path and storage folder; both are now parameters with
 * Finance's own prior values as the default, so every existing Finance call
 * site keeps working byte-for-byte unchanged.
 *
 * `flattenReportRows` normalizes whichever real shape a report's `data`
 * actually has (`rows`/`lines`/`items`/`buckets`/`sections`, or a flat
 * scalar-summary object) into one common flat table — the shape CSV/Excel/
 * PDF all render from, regardless of which module produced the report.
 * `report` itself only needs `{ reportType, data, period?, currency?,
 * generatedAt?, _id }` — any module's report/dashboard-export object that
 * shape, not just FinancialReportModel.
 */
export const flattenReportRows = (reportType, data) => {
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.lines)) return data.lines;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.buckets)) return data.buckets;
  if (data.sections && typeof data.sections === "object") {
    return Object.entries(data.sections).flatMap(([section, rows]) => rows.map((row) => ({ section, ...row })));
  }
  // A scalar-summary report (e.g. RetainedEarnings, or a single dashboard
  // snapshot) — one real row of its own top-level figures.
  const { rows: _rows, lines: _lines, sections: _sections, items: _items, ...scalars } = data;
  return [scalars];
};

const toCsvValue = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

class ReportExportService {
  /**
   * Real CSV — one row per flattened report row, headers from the union of
   * every row's own keys. `permissions` (Part 11 fix — column-level
   * masking): pass `req.auth.permissions` to mask any sensitive field
   * (utils/reportColumnSecurity.js) the caller lacks the permission for;
   * omitted (the default), this is a no-op, matching every export call
   * site's behavior before this fix existed.
   */
  static generateCsv(report, { permissions = null } = {}) {
    const rows = maskSensitiveColumns(flattenReportRows(report.reportType, report.data), permissions);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => toCsvValue(row[h])).join(","))];
    return { content: lines.join("\n"), mimeType: "text/csv", filename: `${report.reportType}-${report._id}.csv` };
  }

  /** Real .xlsx workbook — one worksheet, real cell values (not just text). Same optional `permissions` column-masking as generateCsv. */
  static async generateExcel(report, { permissions = null } = {}) {
    const rows = maskSensitiveColumns(flattenReportRows(report.reportType, report.data), permissions);
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
   * same flattened table, via services/HtmlPdfRenderer.js. `templatePath`
   * defaults to the existing generic tabular template (title/period/
   * currency/generatedAt/headers/displayRows — no Finance-specific field
   * names in its data contract), reusable as-is by any module; pass a
   * different one only once a module needs genuinely different layout/branding.
   *
   * Part 8 fix — template registry: when `tenantId` is supplied, an
   * "Active" ReportTemplateModel entry for this tenant + `report.reportType`
   * + `locale` is tried first (via ReportTemplateService.resolveTemplate)
   * and rendered with the same data contract plus `branding` (the
   * template's own brandingConfig) — a logo/language/layout change is now
   * one DB edit, not a `templatePath` code change. No `tenantId`, or no
   * matching Active template (every pre-existing caller, and every tenant
   * that hasn't registered one), falls back to `templatePath` unchanged.
   */
  static async generatePdfBuffer(report, { templatePath = DEFAULT_PDF_TEMPLATE_PATH, permissions = null, tenantId = null, locale = "en" } = {}) {
    const rows = maskSensitiveColumns(flattenReportRows(report.reportType, report.data), permissions);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8); // A4 landscape width realistically fits ~8 columns.

    const formatCell = (value) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === "object" && value !== null) return JSON.stringify(value);
      return String(value ?? "");
    };

    const displayRows = rows.slice(0, 500).map((row) => headers.map((h) => formatCell(row[h])));
    const data = {
      title: report.reportType.replace(/([A-Z])/g, " $1").trim(),
      period: report.period || "N/A",
      currency: report.currency || "All",
      generatedAt: new Date(report.generatedAt || Date.now()).toISOString().slice(0, 19),
      headers,
      displayRows
    };
    const pdfOptions = { landscape: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } };

    // Part 8 fix — an "Active" DB template for this tenant + reportType +
    // locale wins over the file-based default; no tenantId or no match
    // (every pre-existing caller) falls back exactly as before.
    const dbTemplate = tenantId ? await ReportTemplateService.resolveTemplate({ tenantId, reportType: report.reportType, locale }) : null;
    if (dbTemplate) {
      const cacheKey = `${tenantId}:${dbTemplate.templateKey}:${dbTemplate.locale}:${dbTemplate.version}`;
      return renderHtmlStringToPdfBuffer(dbTemplate.htmlBody, { ...data, branding: dbTemplate.brandingConfig }, pdfOptions, cacheKey);
    }
    return renderHtmlToPdfBuffer(templatePath, data, pdfOptions);
  }

  /**
   * Real export + store, returning the same `{format, url, storageKey,
   * storageProvider, generatedAt}` shape every other Part's own
   * document-export flow already produces. `folder` defaults to Finance's
   * own prior hardcoded value so existing Finance callers are unaffected;
   * other modules pass their own (e.g. "travel-reports", "visa-reports").
   */
  static async exportAndStore(report, format, tenantId, { folder = DEFAULT_STORAGE_FOLDER, templatePath, permissions = null, locale = "en" } = {}) {
    if (format === "CSV") {
      const { content, filename } = ReportExportService.generateCsv(report, { permissions });
      const stored = await storeDocumentPdf({ tenantId, folder, filename, buffer: Buffer.from(content, "utf8") });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    if (format === "Excel") {
      const { buffer, filename } = await ReportExportService.generateExcel(report, { permissions });
      const stored = await storeDocumentPdf({ tenantId, folder, filename, buffer });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    if (format === "PDF") {
      const buffer = await ReportExportService.generatePdfBuffer(report, { templatePath, permissions, tenantId, locale });
      const stored = await storeDocumentPdf({ tenantId, folder, filename: `${report.reportType}-${report._id}.pdf`, buffer });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    if (format === "JSON") {
      // JSON export is the report's own already-stored `data` verbatim — no
      // flattening step happens for JSON today, so column masking doesn't
      // apply here yet; this format returns raw `data` as-is, same as before.
      const stored = await storeDocumentPdf({ tenantId, folder, filename: `${report.reportType}-${report._id}.json`, buffer: Buffer.from(JSON.stringify(report.data, null, 2), "utf8") });
      return { format, url: stored.url, storageKey: stored.storageKey, storageProvider: stored.storageProvider, generatedAt: new Date() };
    }
    throw new Error(`Export format "${format}" is not supported.`);
  }
}

export default ReportExportService;
