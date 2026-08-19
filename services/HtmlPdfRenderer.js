import handlebars from "handlebars";
import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The single chokepoint every *PdfService.js renders a document through —
// PRD "HTML-Template PDF Architecture Migration" Issue 2b. Callers hand it
// a template path + a plain data object; it hands back a PDF Buffer. The
// pdfkit-vs-HTML/Puppeteer choice never leaks past this file.
export const TEMPLATES_DIR = process.env.PDF_TEMPLATES_DIR
  ? path.resolve(process.env.PDF_TEMPLATES_DIR)
  : path.resolve(__dirname, "../templates");

// Some minimal container base images/CI runners need extra Chromium launch
// flags beyond the two always-needed sandbox ones (Issue 4's deployment
// flag) — configurable per-deploy rather than a code change.
const getLaunchArgs = () => {
  const extra = process.env.PUPPETEER_EXTRA_LAUNCH_ARGS_JSON;
  const parsedExtra = extra ? JSON.parse(extra) : [];
  return ["--no-sandbox", "--disable-setuid-sandbox", ...parsedExtra];
};

handlebars.registerHelper("formatNumber", (value) => (typeof value === "number" ? value.toLocaleString() : (value ?? "")));
handlebars.registerHelper("formatDate", (value) => (value ? new Date(value).toISOString().split("T")[0] : ""));
handlebars.registerHelper("formatDateTime", (value) => (value ? new Date(value).toISOString().slice(0, 19).replace("T", " ") : ""));
handlebars.registerHelper("eq", (a, b) => a === b);
handlebars.registerHelper("gt", (a, b) => a > b);
handlebars.registerHelper("inc", (index) => index + 1);

// Compiled-template cache — templates are static files on disk, safe to
// cache indefinitely (unlike tenant DATA, which utils/tenantBranding.js
// correctly never caches). Keyed by absolute template path.
const compiledTemplateCache = new Map();

const getCompiledTemplate = async (templatePath) => {
  if (!compiledTemplateCache.has(templatePath)) {
    const source = await fs.readFile(templatePath, "utf-8");
    compiledTemplateCache.set(templatePath, handlebars.compile(source));
  }
  return compiledTemplateCache.get(templatePath);
};

// Shared CSS (templates/shared/_document_base.css), auto-injected into
// every render's data as `sharedCss` so individual templates just do
// `<style>{{{sharedCss}}}</style>` without each service needing to load it.
let cachedSharedCss = null;
const getSharedCss = async () => {
  if (cachedSharedCss === null) {
    cachedSharedCss = await fs.readFile(path.join(TEMPLATES_DIR, "shared", "_document_base.css"), "utf-8");
  }
  return cachedSharedCss;
};

// Handlebars partials (templates/shared/partials/*.hbs) — registered once,
// lazily, the first time any document is rendered. A partials directory
// that doesn't exist yet is not an error (a document type with no shared
// blocks simply renders without any {{> name}} references).
let partialsRegistered = false;
const registerPartials = async () => {
  if (partialsRegistered) return;
  partialsRegistered = true;
  const partialsDir = path.join(TEMPLATES_DIR, "shared", "partials");
  let files;
  try {
    files = await fs.readdir(partialsDir);
  } catch {
    return;
  }
  await Promise.all(files.filter((f) => f.endsWith(".hbs")).map(async (file) => {
    const name = path.basename(file, ".hbs");
    const source = await fs.readFile(path.join(partialsDir, file), "utf-8");
    handlebars.registerPartial(name, source);
  }));
};

// Lazy singleton — mirrors services/gateways/StripeGatewayAdapter.js's own
// lazy-init pattern (module-level holder + async getter, initialized once,
// only when actually needed) for a different expensive-to-init external
// resource. `browserLaunchPromise` additionally de-dupes concurrent
// first-callers (two PDFs requested before Chromium finishes launching)
// so only one Chromium process is ever spawned, not one per race winner.
let browserInstance = null;
let browserLaunchPromise = null;

export const getBrowser = async () => {
  if (browserInstance) return browserInstance;
  if (!browserLaunchPromise) {
    browserLaunchPromise = puppeteer.launch({
      headless: "new",
      args: getLaunchArgs()
    }).then((browser) => {
      browserInstance = browser;
      return browser;
    }).catch((err) => {
      browserLaunchPromise = null; // allow a retry on the next call
      throw err;
    });
  }
  return browserLaunchPromise;
};

/** Registered against SIGTERM in server.js — releases the Chromium process on graceful shutdown. */
export const closeBrowser = async () => {
  if (browserInstance) {
    const browser = browserInstance;
    browserInstance = null;
    browserLaunchPromise = null;
    await browser.close();
  }
};

/**
 * Renders `templatePath` (an absolute path under TEMPLATES_DIR) with `data`
 * into a PDF Buffer via headless Chromium. `pdfOptions` overrides the A4
 * portrait default (e.g. FinancialReportExportService's landscape report).
 */
export const renderHtmlToPdfBuffer = async (templatePath, data, pdfOptions = {}) => {
  await registerPartials();
  const template = await getCompiledTemplate(templatePath);
  const sharedCss = await getSharedCss();
  const html = template({ ...data, sharedCss });

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // "load" (window.onload — fires once every resource, including the
    // <img> logo fetch, has either finished or failed) rather than
    // "networkidle0" ("0 network connections for 500ms", meant for SPAs
    // with ongoing background polling this content never does). Found
    // networkidle0 to intermittently hang for the full navigation timeout
    // with no external resources at all involved — a real production
    // reliability risk for a customer-facing document generator, not a
    // one-off flake; "load" is also the semantically correct wait
    // condition for a static document whose only "async" content is one
    // image that must resolve or fail before printing.
    await page.setContent(html, { waitUntil: "load" });
    // page.pdf() returns a raw Uint8Array, not a Node Buffer — every
    // *PdfService.js's pdfkit-era contract (Buffer.concat(chunks)) and
    // every caller downstream (storeDocumentPdf, etc.) expects a real
    // Buffer, so this is the one place that conversion happens.
    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      ...pdfOptions
    });
    return Buffer.from(pdfBytes);
  } finally {
    await page.close();
  }
};

export default { renderHtmlToPdfBuffer, getBrowser, closeBrowser, TEMPLATES_DIR };
