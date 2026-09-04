import handlebars from "handlebars";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Per-Tenant Domain-Masked Landing Page (PRD v2 §Task E) — same templating
// engine (Handlebars) services/HtmlPdfRenderer.js already uses for every
// invoice/voucher/receipt, per that PRD's own "match the existing syntax,
// don't introduce a second templating approach" instruction. Deliberately
// a SEPARATE, small render path rather than routing through
// HtmlPdfRenderer.renderHtmlToPdfBuffer: that function always launches
// headless Chromium and returns a PDF Buffer — wrong shape for a live web
// response, which just needs a compiled HTML string served directly, no
// browser round-trip. Its own compiled-template cache/Puppeteer singleton
// are untouched by this file; zero coupling, zero risk to existing PDF
// generation.
const TEMPLATE_PATH = path.resolve(__dirname, "../templates/landingPage/index.html");

let compiledTemplate = null;
const getTemplate = async () => {
  if (!compiledTemplate) {
    const source = await fs.readFile(TEMPLATE_PATH, "utf-8");
    compiledTemplate = handlebars.compile(source);
  }
  return compiledTemplate;
};

export const renderLandingPageHtml = async (data) => {
  const template = await getTemplate();
  return template(data);
};

export default { renderLandingPageHtml };
