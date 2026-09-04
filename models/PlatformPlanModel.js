import mongoose from "mongoose";

// Enterprise Subscription Platform — a CORE platform (utils/platformConfig.js),
// deliberately NOT under Finance. The sellable catalog of plans this ERP
// itself is licensed under — every TenantSubscriptionModel row references
// exactly one of these. Not tenant-scoped — this is the platform operator's
// own catalog, shared across every tenant (the same "genuinely tenant-agnostic
// reference/catalog data" treatment ISO_4217_CURRENCIES/Chart-of-Account
// templates already get elsewhere in this codebase).
const PlatformPlanSchema = new mongoose.Schema({
  planCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  name: { type: String, required: true },
  // Config-driven (planTiers) — Free, Starter, Professional, Business,
  // Enterprise, Custom.
  tier: { type: String, required: true, index: true },
  description: { type: String, default: null },
  // Real per-billing-cycle pricing — a plan may not offer every cycle
  // (e.g. Free has no price at all); missing entries simply aren't sold
  // under that cycle rather than defaulting to 0.
  pricing: {
    currency: { type: String, default: null },
    monthly: { type: Number, default: null, min: 0 },
    quarterly: { type: Number, default: null, min: 0 },
    halfYearly: { type: Number, default: null, min: 0 },
    yearly: { type: Number, default: null, min: 0 }
  },
  // "Tenant Limits" — real, enforceable ceilings. null/0 = unlimited,
  // never a fabricated "large number" standing in for infinity. Keys are
  // config-driven (tenantLimitKeys) — Max Branches/Max Companies from the
  // spec are deliberately absent (see utils/platformConfig.js's own doc
  // comment — no Branch concept, Company IS Tenant).
  limits: {
    maxUsers: { type: Number, default: null },
    maxStorageGB: { type: Number, default: null },
    maxApiCallsPerDay: { type: Number, default: null },
    maxProjects: { type: Number, default: null },
    maxEmployees: { type: Number, default: null },
    aiCreditsPerMonth: { type: Number, default: null }
  },
  // "Feature Flags" — real per-plan boolean gates (config-driven
  // featureKeys). A Map, not a fixed sub-schema, so a new feature key
  // (utils/platformConfig.js) is usable immediately without a migration.
  features: {
    type: Map,
    of: Boolean,
    default: {}
  },
  // Real per-plan override of the platform-wide defaults
  // (platformConfig.defaultTrialDays/defaultGracePeriodDays) — null means
  // "use the platform default", not "zero".
  trialDays: { type: Number, default: null },
  gracePeriodDays: { type: Number, default: null },
  // Enterprise Subscription Automation Layer — Automation #4 (Enterprise
  // Grace Period Engine). "During Grace Period... Business policy
  // configurable... Full Access + Warning Banner | Read Only | Limited
  // Operations." Real, config-driven (platformConfig.gracePeriodAccessPolicies),
  // null means "use the platform default" — same override pattern as
  // gracePeriodDays above. Storing/exposing this is real; a route/module
  // actually CONSULTING it to restrict access is Automation #6's own job
  // (Subscription Enforcement Middleware, not yet built) — see
  // GracePeriodEngineService's own doc comment for why that's an honest,
  // deliberate scope boundary rather than a silently-unused field.
  gracePeriodAccessPolicy: { type: String, default: null },
  // Config-driven (supportLevels/backupFrequencies).
  supportLevel: { type: String, default: null },
  backupFrequency: { type: String, default: null },
  // Whether this plan can currently be newly subscribed to — an existing
  // subscription on a retired plan keeps working (never force-migrated),
  // it just can't be chosen for a NEW subscription.
  isSellable: { type: Boolean, default: true },
  // "Custom" tier plans are negotiated per-tenant, never shown in a public
  // plan catalog listing even while isSellable.
  isCustom: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 },
  timeline: [{
    event: { type: String, required: true },
    description: { type: String, default: null },
    performedBy: { type: String, default: null },
    performedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

PlatformPlanSchema.index({ tier: 1, isSellable: 1 });

PlatformPlanSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const PlatformPlanModel = mongoose.model("platform_plan", PlatformPlanSchema);

export default PlatformPlanModel;
