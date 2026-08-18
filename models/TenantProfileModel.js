import mongoose from "mongoose";

// Agency/Tenant onboarding profile & document branding (booking-module PRD
// Part C item #13). Confirmed via a full-repo grep for `logo` across
// models/ (zero hits) that no branding profile exists anywhere yet.
//
// Deliberately NOT built on models/CompanyModel.js ("org_company") — that
// model is the Enterprise Organisation Structure Platform's lower-level
// operational node BELOW Tenant (Legal Entity -> Business Unit -> Company),
// for tenants running multiple operating companies under one legal entity.
// Forcing every small single-company agency (Document 4's actual use case)
// through that hierarchy just to store a logo would be the wrong tool for
// the job. This is the simple, one-per-tenant profile Document 4 describes,
// same "one document per tenant" shape as TenantSubscriptionModel.
//
// Bank details are NOT duplicated here — `defaultBankAccountId` references
// the existing, already-encrypted BankAccountModel (Finance Module Part
// 13). See Issue 16's own reasoning: a second, unencrypted bank-details
// store on this model would be a real regression, not a convenience.
const TenantProfileSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  companyName: {
    type: String,
    required: true
  },
  logoUrl: {
    type: String,
    default: null
  },
  registrationNumber: {
    type: String,
    default: null
  },
  vatNumber: {
    type: String,
    default: null
  },
  address: {
    type: String,
    default: null
  },
  city: {
    type: String,
    default: null
  },
  country: {
    type: String,
    default: null
  },
  phone: {
    type: String,
    default: null
  },
  email: {
    type: String,
    default: null
  },
  defaultBankAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "bank_account",
    default: null
  },
  documentSettings: {
    invoiceDisplayName: { type: String, default: null },
    termsAndConditions: { type: String, default: null },
    cancellationPolicy: { type: String, default: null },
    operationalContacts: { type: String, default: null }
  },
  profileCompletedAt: {
    type: Date,
    default: null
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

TenantProfileSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TenantProfileModel = mongoose.model("tenant_profile", TenantProfileSchema);

export default TenantProfileModel;
