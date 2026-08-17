import mongoose from "mongoose";

// Per-Tenant Payment Gateway Integration — PRD Issue 12 ("jab plan hit ho
// tabhi phir tenant create hona chahiye... signup pay nahi hona chahiye").
// A real, short-lived holding record for a signup that has NOT yet paid —
// no `TenantModel`/`UserModel` document is ever created until the real
// Stripe `checkout.session.completed` webhook fires and this record is
// consumed. `expiresAt` has a real TTL index so an abandoned signup
// (closed the tab, never paid) is genuinely cleaned up automatically,
// never left as permanent orphaned data.
const PendingTenantSetupSchema = new mongoose.Schema({
  setupToken: { type: String, required: true, unique: true, index: true },
  companyName: { type: String, required: true },
  tenantKey: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  email: { type: String, required: true },
  // A real bcrypt hash, computed once during Phase 1 — never the plain
  // password, and never re-hashed/re-validated at Phase 2, so the
  // password policy check the user already passed isn't silently re-run
  // (or skipped) days later against different config.
  passwordHash: { type: String, required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "platform_plan", required: true },
  billingCycle: { type: String, required: true },
  stripeCheckoutSessionId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});

PendingTenantSetupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PendingTenantSetupModel = mongoose.model("pending_tenant_setup", PendingTenantSetupSchema);

export default PendingTenantSetupModel;
