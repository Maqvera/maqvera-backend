import PublicLandingPageService from "../services/PublicLandingPageService.js";
import { renderLandingPageHtml } from "../services/LandingPageRenderService.js";

// Per-Tenant Domain-Masked Landing Page (PRD v2 §2.3) — the one controller
// in this codebase reached via req.resolvedTenantId (middleware/
// resolveTenantByHost.js) instead of getAccessScope(req). No auth, no
// tenant-scoped WRITE path here — read-only TenantProfileModel/
// PackageTemplateModel/HotelCatalogModel/ReviewModel queries only, exactly
// as PRD v2 §2.3 specifies ("do not add write paths here").
const NOT_CONFIGURED_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Not Configured</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:110px 20px;color:#444;background:#fbfaf7}
h1{font-size:22px;margin-bottom:10px}p{color:#777}</style></head>
<body><h1>This page isn't set up yet</h1><p>No agency is configured for this address.</p></body></html>`;

export const RenderLandingPage = async (req, res) => {
  try {
    if (!req.resolvedTenantId) {
      return res.status(404).set("Content-Type", "text/html; charset=utf-8").send(NOT_CONFIGURED_HTML);
    }

    const data = await PublicLandingPageService.getLandingPageData(req.resolvedTenantId, req.resolvedTenantSlug);
    const html = await renderLandingPageHtml(data);
    return res.status(200).set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (error) {
    console.error("RenderLandingPage error:", error);
    return res.status(500).set("Content-Type", "text/html; charset=utf-8").send(NOT_CONFIGURED_HTML);
  }
};
