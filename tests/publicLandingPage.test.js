import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Domain-Masked Landing Page (PRD v2 §Task F) — end-to-end:
// resolveTenantByHost -> RenderLandingPage, against a real TenantProfileModel
// + a real publicVisible PackageTemplateModel + a real published Review.
// Also covers the unknown-host "not configured" fallback (never a JSON
// error, never a 500 — a friendly HTML page) and confirms an unpublished/
// unmoderated review never appears on the public page.

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const makeRes = () => ({
  statusCode: null,
  headers: {},
  body: null,
  status(code) { this.statusCode = code; return this; },
  set(key, value) { this.headers[key] = value; return this; },
  send(payload) { this.body = payload; return this; },
});

test("Public Landing Page: full render with real package/review data, empty-tenant fallback, unknown-host page", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const resolveTenantByHost = (await import("../middleware/resolveTenantByHost.js")).default;
  const landingCtrl = await import("../controllers/PublicLandingPageController.js");
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const TenantProfileModel = (await import("../models/TenantProfileModel.js")).default;
  const PackageTemplateModel = (await import("../models/PackageTemplateModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const ReviewModel = (await import("../models/ReviewModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-landing-${suffix}`;
  const slug = `test-landing-agency-${suffix}`;

  const cleanupModels = [TenantProfileModel, PackageTemplateModel, CustomerModel, BookingHeaderModel, ReviewModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await TenantModel.deleteMany({ tenantKey: tenantId });
  });

  // PublicBookingService.listPublicPackages (reused by
  // PublicLandingPageService for the featured-packages section) requires a
  // real, active TenantModel row — without it the packages section would
  // silently render empty, same discipline as tests/publicBooking.test.js.
  await TenantModel.create({ tenantKey: tenantId, name: `Landing Test Agency ${suffix}`, status: "active" });

  await TenantProfileModel.create({
    tenantId, companyName: `Landing Test Agency ${suffix}`, publicSlug: slug,
    registrationNumber: "REG-1", email: "hello@example.com",
    documentSettings: { tagline: "Test Tagline", aboutText: "A short about section for testing." },
    socialLinks: { facebook: "https://facebook.com/test" }
  });

  await PackageTemplateModel.create({
    tenantId, name: "Test Umrah Package", active: true, publicVisible: true,
    packageType: "Umrah", displayPriceFrom: 800, displayCurrency: "USD", sellingCurrency: "USD",
    segments: [{ city: "Makkah", hotelCatalogId: new mongoose.Types.ObjectId(), offsetDays: 0, nights: 5 }]
  });

  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "Land", lastName: "Ing", email: `land.${suffix}@example.com`, phone: `+9230${suffix}`.slice(0, 15) });
  const booking = await BookingHeaderModel.create({ tenantId, bookingReference: `BK-${suffix}`, customerId: customer._id, currency: "USD" });
  await ReviewModel.create({ tenantId, customerId: customer._id, bookingId: booking._id, packageRating: 5, comment: "Great trip, highly recommend!", status: "published" });
  // An unmoderated review must never appear on the public page.
  const booking2 = await BookingHeaderModel.create({ tenantId, bookingReference: `BK2-${suffix}`, customerId: customer._id, currency: "USD" });
  await ReviewModel.create({ tenantId, customerId: customer._id, bookingId: booking2._id, packageRating: 1, comment: "Should never be visible.", status: "pending" });

  // ---- Full flow: middleware resolves, controller renders ----
  // resolveTenantByHost calls next() without awaiting it (correct,
  // matches real Express semantics — next() is fire-and-forget from a
  // middleware's own perspective), so this test must capture and await
  // the promise next() kicks off itself, not assume it's done the moment
  // resolveTenantByHost's own await resolves.
  const req = { headers: { host: `${slug}.maqvera.com` } };
  const res = makeRes();
  let renderPromise;
  await resolveTenantByHost(req, res, () => { renderPromise = landingCtrl.RenderLandingPage(req, res); });
  await renderPromise;

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(res.body, /Landing Test Agency/);
  assert.match(res.body, /Test Umrah Package/);
  assert.match(res.body, /From USD 800/);
  assert.match(res.body, /Great trip, highly recommend!/);
  assert.doesNotMatch(res.body, /Should never be visible\./, "an unpublished/pending review must never render on the public page");
  assert.doesNotMatch(res.body, /\{\{/, "no unrendered Handlebars tokens should leak into the response");

  // ---- Unknown host -> friendly 404 HTML, never a JSON error/500 ----
  const reqUnknown = { headers: { host: "no-such-agency.maqvera.com" } };
  const resUnknown = makeRes();
  let renderPromiseUnknown;
  await resolveTenantByHost(reqUnknown, resUnknown, () => { renderPromiseUnknown = landingCtrl.RenderLandingPage(reqUnknown, resUnknown); });
  await renderPromiseUnknown;
  assert.equal(resUnknown.statusCode, 404);
  assert.match(resUnknown.body, /isn't set up yet/);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
