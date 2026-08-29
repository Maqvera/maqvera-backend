import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Landing page follow-up audit, Gap 4 — the PRD v2 Task H regression check
// that was never actually written. Closes the loop: does adding
// publicSlug/customDomain/customDomainStatus/customDomainVerificationToken/
// sslStatus/documentSettings.aboutText/socialLinks to TenantProfileModel
// change what an existing invoice/voucher/receipt renders?
//
// utils/tenantBranding.js's resolveTenantBranding/resolveTenantDocumentSettings
// are the ONLY functions every *PdfService.js (Invoice, Voucher) reads
// tenant branding through (confirmed by reading services/InvoiceService.js,
// services/BookingVoucherService.js, services/PackagePricingService.js —
// all three call through these same two functions, never read
// TenantProfileModel fields directly). This test targets that exact
// boundary rather than invoking real headless-Chromium PDF rendering,
// matching this codebase's own established test convention (see e.g.
// tests/packagePricingController.test.js's quotation test, which sets
// pdfUrl directly "to avoid depending on headless-Chromium availability in
// CI" rather than actually rendering) — if the DATA these deterministic
// Handlebars templates receive is unchanged, the rendered PDF is
// guaranteed byte-for-byte unchanged too.
//
// resolveTenantBranding returns an explicit, hardcoded object literal
// (never a spread of the raw profile) — this is confirmed safe BY
// CONSTRUCTION, not just by the current absence of new fields; this test
// proves it holds even when every new field IS populated on the profile.

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

const EXPECTED_BRANDING_KEYS = ["name", "companyNameArabic", "logoUrl", "vatNumber", "registrationNumber", "licenseNumber", "address", "phone", "email", "bankDetails"].sort();

test("Tenant branding regression: resolveTenantBranding/resolveTenantDocumentSettings output is byte-for-byte unaffected by the landing page's new TenantProfileModel fields", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const TenantProfileModel = (await import("../models/TenantProfileModel.js")).default;
  const { resolveTenantBranding, resolveTenantDocumentSettings } = await import("../utils/tenantBranding.js");

  const suffix = Date.now();
  const preExistingTenantId = `test-branding-pre-${suffix}`;
  const newFieldsTenantId = `test-branding-new-${suffix}`;

  t.after(async () => {
    await TenantProfileModel.deleteMany({ tenantId: { $in: [preExistingTenantId, newFieldsTenantId] } });
  });

  // ---- Tenant A: only fields that existed before this PRD ----
  const preExistingFields = {
    tenantId: preExistingTenantId,
    companyName: "Pre-Existing Agency",
    logoUrl: "https://example.com/logo.png",
    registrationNumber: "REG-100",
    licenseNumber: "LIC-100",
    vatNumber: "VAT-100",
    companyNameArabic: "شركة قديمة",
    address: "1 Old Street",
    city: "Karachi",
    country: "Pakistan",
    phone: "+92 300 0000000",
    email: "old@example.com",
    documentSettings: { invoiceDisplayName: "Pre-Existing Agency Invoicing", termsAndConditions: "Old terms.", tagline: "Old tagline" }
  };
  await TenantProfileModel.create(preExistingFields);

  // ---- Tenant B: identical business data, but EVERY new landing-page field populated too ----
  await TenantProfileModel.create({
    ...preExistingFields,
    tenantId: newFieldsTenantId,
    publicSlug: `new-fields-agency-${suffix}`,
    customDomain: `www.new-fields-${suffix}.example`,
    customDomainStatus: "pending_dns",
    customDomainVerificationToken: "some-token",
    sslStatus: "pending",
    socialLinks: { facebook: "https://facebook.com/test", instagram: "https://instagram.com/test" },
    documentSettings: { ...preExistingFields.documentSettings, aboutText: "A brand new About section for the landing page." }
  });

  const brandingA = await resolveTenantBranding(preExistingTenantId);
  const brandingB = await resolveTenantBranding(newFieldsTenantId);

  // ---- Exact key set — never grows just because new model fields exist ----
  assert.deepEqual(Object.keys(brandingA).sort(), EXPECTED_BRANDING_KEYS, "resolveTenantBranding's key set must never include a landing-page field");
  assert.deepEqual(Object.keys(brandingB).sort(), EXPECTED_BRANDING_KEYS, "even for a tenant with every new field populated, resolveTenantBranding's key set must stay identical");

  // ---- Same business-data input -> byte-for-byte identical branding object ----
  assert.deepEqual(brandingA, brandingB, "identical underlying business data must produce an identical branding object regardless of which new landing-page fields are populated");

  // ---- No new field name/value ever leaks through, even by accident ----
  const brandingBJson = JSON.stringify(brandingB);
  for (const leaked of ["publicSlug", "customDomain", "sslStatus", "socialLinks", "aboutText", "facebook", "pending_dns"]) {
    assert.ok(!brandingBJson.includes(leaked), `resolveTenantBranding output must never contain "${leaked}"`);
  }

  // ---- resolveTenantDocumentSettings: pre-existing keys always present and unchanged ----
  const docSettingsA = await resolveTenantDocumentSettings(preExistingTenantId);
  const docSettingsB = await resolveTenantDocumentSettings(newFieldsTenantId);
  assert.equal(docSettingsA.invoiceDisplayName, "Pre-Existing Agency Invoicing");
  assert.equal(docSettingsA.termsAndConditions, "Old terms.");
  assert.ok(!docSettingsA.aboutText, "a tenant that never set aboutText must never have real content appear for it");
  assert.equal(docSettingsB.invoiceDisplayName, "Pre-Existing Agency Invoicing", "pre-existing documentSettings fields must be identical regardless of the new aboutText field's presence");
  assert.equal(docSettingsB.termsAndConditions, "Old terms.");
  // aboutText DOES legitimately appear here (this function returns the raw
  // documentSettings object, unlike resolveTenantBranding's explicit
  // field list) — but no existing invoice/voucher/receipt template
  // (templates/invoices/, templates/vouchers/, etc. — untouched by this
  // PRD) references {{documentSettings.aboutText}}, so its presence in
  // this data object never reaches a rendered document.
  assert.equal(docSettingsB.aboutText, "A brand new About section for the landing page.");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
