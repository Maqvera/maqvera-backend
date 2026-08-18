import TenantProfileModel from "../models/TenantProfileModel.js";
import BankAccountModel from "../models/BankAccountModel.js";

/**
 * Resolves the `company` branding object every server-generated financial
 * PDF (Invoice, Client Voucher) needs — booking-module PRD Part C item #15.
 * Shared here rather than duplicated in InvoiceService and
 * BookingVoucherService, both of which need the exact same
 * TenantProfileModel -> BankAccountModel resolution.
 *
 * Never fabricates a fallback: a tenant with no profile set up yet gets
 * `null` (the caller's PDF template already treats a missing `company` as
 * "render without a branding header," not an error) — same "don't create
 * fake/placeholder fields" discipline as the rest of this PRD.
 */
export const resolveTenantBranding = async (tenantId) => {
  const tenantProfile = await TenantProfileModel.findOne({ tenantId }).lean();
  if (!tenantProfile) return null;

  const bankAccount = tenantProfile.defaultBankAccountId
    ? await BankAccountModel.findOne({ _id: tenantProfile.defaultBankAccountId, tenantId }).lean()
    : null;

  return {
    name: tenantProfile.companyName,
    logoUrl: tenantProfile.logoUrl,
    vatNumber: tenantProfile.vatNumber,
    registrationNumber: tenantProfile.registrationNumber,
    address: tenantProfile.address,
    phone: tenantProfile.phone,
    email: tenantProfile.email,
    bankDetails: bankAccount ? {
      bankName: bankAccount.bankName,
      accountName: bankAccount.accountName,
      accountNumberLast4: bankAccount.accountNumberLast4,
      iban: bankAccount.iban,
      swiftCode: bankAccount.swiftCode
    } : null
  };
};

export const resolveTenantDocumentSettings = async (tenantId) => {
  const tenantProfile = await TenantProfileModel.findOne({ tenantId }).lean();
  return tenantProfile?.documentSettings || null;
};
