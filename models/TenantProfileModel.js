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
  // Public B2C Booking Site (PRD "CRM Feature Map by Phase" Phase 2 module
  // 15) — the tenant identifier a stranger's browser sends on
  // GET /public/packages?tenantSlug=..., never the raw internal `tenantId`.
  // Sparse+unique so most tenants (who never opt into a public site) simply
  // leave it null without colliding on a shared null value.
  // No `default: null` here on purpose (regression found by PRD v2's Task
  // H mandatory re-run of the existing suite): a sparse unique index only
  // excludes a document where the field is genuinely ABSENT, not one
  // where it's explicitly present with value null — `setDefaultsOnInsert`
  // (used by this model's several upsert call sites, e.g.
  // UpdateTenantSettings/UploadTenantProfileLogo, which never mean to
  // touch this field at all) would otherwise materialize `publicSlug:
  // null` on every such insert, and a second unrelated tenant's insert
  // would then collide on that same null value. Every read site already
  // treats "field absent" and "field null" identically (`profile
  // .publicSlug || …`, never a strict `=== null` check), so dropping the
  // default changes no behavior except fixing this exact collision.
  publicSlug: {
    type: String,
    lowercase: true,
    trim: true,
    unique: true,
    sparse: true,
    index: true
  },
  // PRD "CRM Feature Map by Phase" Phase 4 module 30 (White-Label). Backend-
  // only today — no frontend in this repo consumes them yet (this IS an
  // API-only repo; theming the actual UI is a separate frontend-repo
  // concern). A tenant opting into white-label sets these; every other
  // tenant leaves them null and gets no visual change.
  primaryColor: {
    type: String,
    default: null
  },
  secondaryColor: {
    type: String,
    default: null
  },
  // Same "no default: null" fix as publicSlug above, for the same
  // sparse-unique-index-collides-on-explicit-null reason — this field has
  // its own separate `{ customDomain: 1 }` unique+sparse index below.
  customDomain: {
    type: String
  },
  // Per-Tenant Domain-Masked Landing Page — Tier 2 (custom domain, PRD v2
  // §2.1/§2.5). Deliberately does NOT introduce a new nested
  // `domainSettings.{slug,customDomain}` object the way that PRD's draft
  // schema shows — `publicSlug` (Public B2C Booking Site) and
  // `customDomain` (White-Label) already exist as flat fields above and
  // already serve those exact two roles; duplicating them nested would
  // create two sources of truth for the same tenant identifier. Only the
  // genuinely new companion fields are added here, flat, next to the
  // `customDomain` field they describe the status of.
  customDomainStatus: {
    type: String,
    enum: ["unset", "pending_dns", "verified", "failed"],
    default: "unset"
  },
  customDomainVerificationToken: {
    type: String,
    default: null
  },
  sslStatus: {
    type: String,
    enum: ["not_applicable", "pending", "active", "failed"],
    default: "not_applicable"
  },
  // Commercial Registration number (السجل التجاري).
  registrationNumber: {
    type: String,
    default: null
  },
  // License Number (رقم الترخيص) — genuinely distinct from the Commercial
  // Registration number above (confirmed against a real reference invoice
  // showing both simultaneously), not a rename/duplicate of it.
  licenseNumber: {
    type: String,
    default: null
  },
  vatNumber: {
    type: String,
    default: null
  },
  // Optional Arabic company name, rendered as a second line under the
  // English name when present — never fabricated/transliterated when absent.
  companyNameArabic: {
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
    operationalContacts: { type: String, default: null },
    // Short line under the company name on generated documents (e.g. "for
    // Organizing Trips") — genuinely per-tenant, never a fixed string baked
    // into the template for every tenant.
    tagline: { type: String, default: null },
    // Voucher opening greeting line — tenant-overridable; the template
    // falls back to a fixed default boilerplate when this is unset.
    greetingText: { type: String, default: null },
    // Per-Tenant Domain-Masked Landing Page (PRD v2 §2.1) — the "About the
    // agency" section's free text. New, optional, default null — every
    // existing document that reads documentSettings (invoices/vouchers/
    // receipts) never touches this key, so nothing about their output changes.
    aboutText: { type: String, default: null }
  },
  // Per-Tenant Domain-Masked Landing Page (PRD v2 §2.1) — footer section
  // only; explicit known fields rather than a Mixed bag, matching this
  // model's own existing preference for typed fields over free-form ones.
  socialLinks: {
    facebook: { type: String, default: null },
    instagram: { type: String, default: null },
    twitter: { type: String, default: null },
    linkedin: { type: String, default: null },
    youtube: { type: String, default: null },
    tiktok: { type: String, default: null }
  },
  profileCompletedAt: {
    type: Date,
    default: null
  },
  // PRD "CRM Feature Map by Phase" Phase 1 module 13 (Settings). Tenant-WIDE
  // channel toggles — deliberately distinct from CommunicationPreferenceModel,
  // which is per-STAFF-USER opt-in/DND (see that model's own doc comment).
  // Turning a channel off here means "this agency doesn't use WhatsApp,"
  // not "this one user opted out."
  notificationPreferences: {
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: true },
    whatsapp: { type: Boolean, default: true }
  },
  // Metadata flag only, per the PRD task's own scope note — this is a
  // settings-screen toggle, not a real backup pipeline. No scheduler reads
  // these fields; a future backup feature would.
  backupEnabled: { type: Boolean, default: false },
  backupFrequency: { type: String, enum: ["Daily", "Weekly", "Monthly"], default: "Daily" },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

// sparse — every tenant that hasn't opted into a custom domain leaves this
// null, and a plain unique index would otherwise collide on the first two
// nulls (same reasoning as every other optional-unique field in this codebase).
TenantProfileSchema.index({ customDomain: 1 }, { unique: true, sparse: true });

TenantProfileSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const TenantProfileModel = mongoose.model("tenant_profile", TenantProfileSchema);

export default TenantProfileModel;
