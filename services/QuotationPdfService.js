import path from "path";
import { renderHtmlToPdfBuffer, TEMPLATES_DIR } from "./HtmlPdfRenderer.js";

const TEMPLATE_PATH = path.join(TEMPLATES_DIR, "packages", "quotation.html");

// Package Pricing Engine — PRD §89. Same thin-wrapper convention as
// services/CustomerStatementPdfService.js: a single `quotation` data object
// in, a PDF Buffer out, entirely populated from QuotationModel's own
// frozen snapshotData (never a live re-read of the package).
class QuotationPdfService {
  static async generatePdfBuffer(quotation) {
    return renderHtmlToPdfBuffer(TEMPLATE_PATH, quotation);
  }
}

export default QuotationPdfService;
