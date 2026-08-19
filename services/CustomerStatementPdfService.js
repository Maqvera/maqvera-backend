import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "statements", "customer_statement.html");

/**
 * Customer Account Statement PDF (booking-module PRD Part A item #6) —
 * HTML-template + headless-Chromium rendering (services/HtmlPdfRenderer.js),
 * PRD "HTML-Template PDF Architecture Migration". Same public contract as
 * the pdfkit-era version this replaced (a single `statement` object,
 * unchanged) — populated entirely from CustomerAccountStatementService.
 * getStatement()'s live data, never a separately-maintained template with
 * its own totals.
 */
class CustomerStatementPdfService {
  static async generatePdfBuffer(statement) {
    const currency = statement.rows[0]?.currency || "USD";
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, {
      ...statement,
      currency,
      hasPeriod: Boolean(statement.period?.dateFrom || statement.period?.dateTo)
    });
  }
}

export default CustomerStatementPdfService;
