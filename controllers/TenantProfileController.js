import TenantProfileModel from "../models/TenantProfileModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import storeDocumentPdf from "../utils/documentPdfStorage.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { slugify } from "../utils/slugify.js";

/**
 * Agency/Tenant onboarding profile & document branding (booking-module PRD
 * Part C item #14). Built as its own follow-up step — `POST /tenant-profile`
 * — rather than folded into the payment-gateway PRD's Phase 2 webhook
 * (TenantProvisioningService.provisionTenant): that webhook fires from a
 * Stripe callback with no user present, and PendingTenantSetupModel (the
 * intent it's created from) only ever collects companyName/tenantKey/
 * username/email/password — no VAT/registration/logo. A logo specifically
 * needs a real authenticated file upload, which can't happen before the
 * tenant/user exist. Document 4 §20's own flow diagram already treats
 * "Company Profile setup" as a distinct step after "Tenant Created," so
 * this matches the diagram as written, not a deviation from it.
 *
 * Deliberately NOT a hard blocker on using the rest of the ERP (Issue 14
 * point 3) — only invoice/voucher generation checks for profile
 * completeness (see InvoiceService/BookingVoucherService's own checks).
 */
export const GetTenantProfile = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("tenantprofile.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const profile = await TenantProfileModel.findOne({ tenantId: scope.tenantId }).lean();
    return sendSuccess(res, 200, profile ? "Tenant profile loaded." : "No tenant profile has been set up yet.", profile, requestId);
  } catch (error) {
    console.error("GetTenantProfile error:", error);
    return sendError(res, 500, "Unable to load tenant profile.", requestId);
  }
};

export const CreateOrUpdateTenantProfile = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("tenantprofile.manage") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      companyName, registrationNumber, licenseNumber, vatNumber, companyNameArabic, address, city, country, phone, email,
      defaultBankAccountId, documentSettings, primaryColor, secondaryColor, customDomain, publicSlug
    } = req.body;

    if (defaultBankAccountId) {
      const bankAccount = await BankAccountModel.findOne({ _id: defaultBankAccountId, tenantId: scope.tenantId }).lean();
      if (!bankAccount) return sendError(res, 422, "defaultBankAccountId does not refer to a bank account on this tenant.", requestId);
    }

    const existing = await TenantProfileModel.findOne({ tenantId: scope.tenantId }).lean();

    // publicSlug and customDomain are STICKY, unlike every other field on
    // this full-replace-style save endpoint (PRD v2 §Task B: "Never
    // regenerate an existing slug on subsequent profile updates" — an
    // omitted field here must never silently wipe out an already-shared
    // public URL the way a full-replace would for every other field).
    // `publicSlug` in req.body === undefined means "the caller didn't
    // mention it," not "clear it" — an explicit `null`/`""` still clears it.
    let normalizedSlug = existing?.publicSlug ?? null;
    if (publicSlug !== undefined) {
      if (publicSlug) {
        normalizedSlug = publicSlug.toLowerCase().trim();
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedSlug)) {
          return sendError(res, 422, "publicSlug must be lowercase letters, numbers, and hyphens only (no leading/trailing hyphen).", requestId);
        }
        const slugTaken = await TenantProfileModel.findOne({ publicSlug: normalizedSlug, tenantId: { $ne: scope.tenantId } }).lean();
        if (slugTaken) return sendError(res, 409, `publicSlug "${normalizedSlug}" is already in use by another tenant.`, requestId);
      } else {
        normalizedSlug = null;
      }
    } else if (!normalizedSlug && companyName) {
      // First-time profile creation with no explicit slug — auto-generate
      // one from companyName (PRD v2 §Task B), the same "{slug}.maqvera.com"
      // identifier the landing page and public booking site both resolve
      // tenants by. Collision handling: append -2, -3, ... until free.
      const base = slugify(companyName);
      normalizedSlug = base;
      let suffix = 2;
      while (await TenantProfileModel.findOne({ publicSlug: normalizedSlug, tenantId: { $ne: scope.tenantId } }).lean()) {
        normalizedSlug = `${base}-${suffix}`;
        suffix += 1;
      }
    }

    // Landing page follow-up audit, Gap 3 — customDomainStatus must never
    // stay silently "unset" (or worse, an already-"verified" domain's
    // status silently untouched) after a genuinely new/changed domain is
    // submitted here. Task G (Cloudflare custom-hostname verification)
    // doesn't exist yet, so there is no automated path to "verified" —
    // this only ever honestly reports "pending_dns" and says so in the
    // response, never silently accepts input that can never work.
    let normalizedCustomDomain = existing?.customDomain ?? null;
    let customDomainStatusUpdate;
    if (customDomain !== undefined) {
      if (customDomain) {
        normalizedCustomDomain = customDomain;
        const domainTaken = await TenantProfileModel.findOne({ customDomain, tenantId: { $ne: scope.tenantId } }).lean();
        if (domainTaken) return sendError(res, 409, `customDomain "${customDomain}" is already in use by another tenant.`, requestId);
        // A resubmission of the SAME already-verified domain must not reset
        // its status back to pending — only a genuinely new/changed value does.
        if (customDomain !== existing?.customDomain) customDomainStatusUpdate = "pending_dns";
      } else {
        normalizedCustomDomain = null;
        customDomainStatusUpdate = "unset";
      }
    }

    const userId = req.auth?.id || null;
    const update = {
      companyName,
      registrationNumber: registrationNumber ?? null,
      licenseNumber: licenseNumber ?? null,
      vatNumber: vatNumber ?? null,
      companyNameArabic: companyNameArabic ?? null,
      address: address ?? null,
      city: city ?? null,
      country: country ?? null,
      phone: phone ?? null,
      email: email ?? null,
      defaultBankAccountId: defaultBankAccountId || null,
      documentSettings: documentSettings || null,
      primaryColor: primaryColor ?? null,
      secondaryColor: secondaryColor ?? null,
      updatedBy: userId
    };

    // publicSlug/customDomain: $unset (never $set to null) when clearing —
    // both carry a sparse unique index, which only excludes a genuinely
    // ABSENT field, not one explicitly present with value null. $set-ing
    // null here would let two different tenants collide the same way the
    // regression above did.
    const unset = {};
    if (normalizedSlug) update.publicSlug = normalizedSlug; else unset.publicSlug = "";
    if (normalizedCustomDomain) update.customDomain = normalizedCustomDomain; else unset.customDomain = "";
    if (customDomainStatusUpdate !== undefined) {
      update.customDomainStatus = customDomainStatusUpdate;
      update.customDomainVerificationToken = null; // no verification flow exists yet to have issued a real one
    }

    const updateOps = { $set: { ...update, profileCompletedAt: new Date() }, $setOnInsert: { tenantId: scope.tenantId, createdBy: userId } };
    if (Object.keys(unset).length > 0) updateOps.$unset = unset;

    const profile = await TenantProfileModel.findOneAndUpdate(
      { tenantId: scope.tenantId },
      updateOps,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const responseData = profile.toJSON();
    // Honest signal for a frontend: a pending custom domain is saved but
    // will not route any traffic until domain verification (Task G) ships.
    if (profile.customDomain && profile.customDomainStatus === "pending_dns") {
      responseData.domainVerificationRequired = true;
      responseData.warnings = ["Custom domain saved — DNS verification isn't available yet, this domain won't route traffic until that ships."];
    }

    return sendSuccess(res, existing ? 200 : 201, "Tenant profile saved.", responseData, requestId);
  } catch (error) {
    console.error("CreateOrUpdateTenantProfile error:", error);
    return sendError(res, 500, "Unable to save tenant profile.", requestId);
  }
};

/**
 * GET /api/v1/tenant-profile/theme — PRD "CRM Feature Map by Phase" Phase 4
 * module 30 (White-Label). Backend-only piece of that module; no repo-local
 * frontend consumes it yet (this is an API-only repo) — theming the actual
 * UI, custom-domain routing, and franchise/multi-city hierarchy are all out
 * of scope here and belong to whichever frontend/infra repo owns them.
 */
export const GetTenantTheme = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("tenantprofile.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const profile = await TenantProfileModel.findOne({ tenantId: scope.tenantId })
      .select("companyName logoUrl primaryColor secondaryColor customDomain").lean();

    const defaults = { companyName: null, logoUrl: null, primaryColor: null, secondaryColor: null, customDomain: null };
    return sendSuccess(res, 200, "Tenant theme loaded.", profile
      ? { companyName: profile.companyName, logoUrl: profile.logoUrl, primaryColor: profile.primaryColor, secondaryColor: profile.secondaryColor, customDomain: profile.customDomain }
      : defaults, requestId);
  } catch (error) {
    console.error("GetTenantTheme error:", error);
    return sendError(res, 500, "Unable to load tenant theme.", requestId);
  }
};

/**
 * GET/PUT /api/v1/tenant-profile/settings — PRD "CRM Feature Map by Phase"
 * Phase 1 module 13 (Settings). Split out from GetTenantProfile/
 * CreateOrUpdateTenantProfile above deliberately: those two carry
 * companyName as a required field and represent the onboarding/branding
 * workflow, while notification-channel/backup toggles are a separate,
 * always-optional settings concern that shouldn't require re-submitting
 * (or risk clobbering) the company profile fields.
 */
export const GetTenantSettings = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("tenantprofile.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const profile = await TenantProfileModel.findOne({ tenantId: scope.tenantId })
      .select("notificationPreferences backupEnabled backupFrequency").lean();

    const defaults = { notificationPreferences: { email: true, sms: true, whatsapp: true }, backupEnabled: false, backupFrequency: "Daily" };
    return sendSuccess(res, 200, "Tenant settings loaded.", profile ? { notificationPreferences: profile.notificationPreferences, backupEnabled: profile.backupEnabled, backupFrequency: profile.backupFrequency } : defaults, requestId);
  } catch (error) {
    console.error("GetTenantSettings error:", error);
    return sendError(res, 500, "Unable to load tenant settings.", requestId);
  }
};

export const UpdateTenantSettings = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("tenantprofile.manage") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { notificationPreferences, backupEnabled, backupFrequency } = req.body;
    const set = { updatedBy: req.auth?.id || null };
    if (notificationPreferences) {
      if (notificationPreferences.email !== undefined) set["notificationPreferences.email"] = notificationPreferences.email;
      if (notificationPreferences.sms !== undefined) set["notificationPreferences.sms"] = notificationPreferences.sms;
      if (notificationPreferences.whatsapp !== undefined) set["notificationPreferences.whatsapp"] = notificationPreferences.whatsapp;
    }
    if (backupEnabled !== undefined) set.backupEnabled = backupEnabled;
    if (backupFrequency !== undefined) set.backupFrequency = backupFrequency;

    // Same "settings can be touched before the company profile is fully
    // filled out" upsert-with-placeholder stance as UploadTenantProfileLogo.
    const profile = await TenantProfileModel.findOneAndUpdate(
      { tenantId: scope.tenantId },
      { $set: set, $setOnInsert: { tenantId: scope.tenantId, companyName: "Untitled Company", createdBy: req.auth?.id || null } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, 200, "Tenant settings saved.", { notificationPreferences: profile.notificationPreferences, backupEnabled: profile.backupEnabled, backupFrequency: profile.backupFrequency }, requestId);
  } catch (error) {
    console.error("UpdateTenantSettings error:", error);
    return sendError(res, 500, "Unable to save tenant settings.", requestId);
  }
};

/**
 * POST /api/v1/tenant-profile/logo — memoryStorage upload, same pattern as
 * BookingController.js's uploadSupplierDocumentFile / ExpenseController.js's
 * uploadReceiptFile, then routed through the existing storeDocumentPdf
 * bridge (works for any buffer, not just PDFs, despite the name) so this
 * reuses the one real cloud/local storage abstraction rather than adding a
 * second image-upload path.
 */
export const UploadTenantProfileLogo = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("tenantprofile.manage") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }
    if (!req.file?.buffer?.length) return sendError(res, 422, "A logo file is required.", requestId);

    const filename = `logo-${Date.now()}-${(req.file.originalname || "logo").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const stored = await storeDocumentPdf({ tenantId: scope.tenantId, folder: "tenant-branding", filename, buffer: req.file.buffer });

    // companyName is required on the schema — a logo uploaded before any
    // profile exists still needs a valid document to upsert into, so
    // $setOnInsert supplies a placeholder the user is expected to replace
    // via CreateOrUpdateTenantProfile (same "don't block on completeness"
    // stance as the rest of this controller).
    const profile = await TenantProfileModel.findOneAndUpdate(
      { tenantId: scope.tenantId },
      {
        $set: { logoUrl: stored.url, updatedBy: req.auth?.id || null },
        $setOnInsert: { tenantId: scope.tenantId, companyName: "Untitled Company", createdBy: req.auth?.id || null }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, 200, "Logo uploaded.", { logoUrl: profile.logoUrl }, requestId);
  } catch (error) {
    console.error("UploadTenantProfileLogo error:", error);
    return sendError(res, 500, "Unable to upload logo.", requestId);
  }
};
