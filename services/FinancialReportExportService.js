import ReportExportService, { flattenReportRows } from "./ReportExportService.js";

/**
 * Reporting Platform Part 9 fix — this file's real generation logic
 * (CSV/Excel/PDF/flattenReportRows) moved to the module-agnostic
 * services/ReportExportService.js; this is now a thin, backward-compatible
 * wrapper so every existing Finance call site (FinancialReportController.js,
 * financialReportScheduler.js, PackagePricingService.js,
 * TenantSubscriptionController.js) keeps working byte-for-byte unchanged,
 * including the "financial-reports" storage folder Finance always used.
 * New code (Travel/Visa report export) should call ReportExportService directly.
 */
const FINANCE_STORAGE_FOLDER = "financial-reports";

class FinancialReportExportService {
  static generateCsv(report, options = {}) {
    return ReportExportService.generateCsv(report, options);
  }

  static async generateExcel(report, options = {}) {
    return ReportExportService.generateExcel(report, options);
  }

  static async generatePdfBuffer(report, options = {}) {
    return ReportExportService.generatePdfBuffer(report, options);
  }

  static async exportAndStore(report, format, tenantId, options = {}) {
    return ReportExportService.exportAndStore(report, format, tenantId, { folder: FINANCE_STORAGE_FOLDER, ...options });
  }
}

export { flattenReportRows };
export default FinancialReportExportService;
