import TenantProfileModel from "../models/TenantProfileModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import storeDocumentPdf from "../utils/documentPdfStorage.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

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
      companyName, registrationNumber, vatNumber, address, city, country, phone, email,
      defaultBankAccountId, documentSettings
    } = req.body;

    if (defaultBankAccountId) {
      const bankAccount = await BankAccountModel.findOne({ _id: defaultBankAccountId, tenantId: scope.tenantId }).lean();
      if (!bankAccount) return sendError(res, 422, "defaultBankAccountId does not refer to a bank account on this tenant.", requestId);
    }

    const userId = req.auth?.id || null;
    const update = {
      companyName,
      registrationNumber: registrationNumber ?? null,
      vatNumber: vatNumber ?? null,
      address: address ?? null,
      city: city ?? null,
      country: country ?? null,
      phone: phone ?? null,
      email: email ?? null,
      defaultBankAccountId: defaultBankAccountId || null,
      documentSettings: documentSettings || null,
      updatedBy: userId
    };

    const existing = await TenantProfileModel.findOne({ tenantId: scope.tenantId });
    const profile = await TenantProfileModel.findOneAndUpdate(
      { tenantId: scope.tenantId },
      {
        $set: { ...update, profileCompletedAt: new Date() },
        $setOnInsert: { tenantId: scope.tenantId, createdBy: userId }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return sendSuccess(res, existing ? 200 : 201, "Tenant profile saved.", profile.toJSON(), requestId);
  } catch (error) {
    console.error("CreateOrUpdateTenantProfile error:", error);
    return sendError(res, 500, "Unable to save tenant profile.", requestId);
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
