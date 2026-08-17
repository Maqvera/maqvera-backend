import mongoose from "mongoose";

const TenantSchema = new mongoose.Schema({
    tenantKey: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    name: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ["active", "inactive", "suspended", "deleted"],
        default: "active",
        index: true
    },
    // Enterprise Subscription Platform — real audit context for WHY a
    // tenant is suspended. `status` itself remains the actual
    // access-control switch (already enforced throughout
    // controllers/Auth.js and middleware/authenticateAccessToken.js) —
    // these two fields never gate anything on their own, they only
    // explain the switch's last flip. Cleared back to null on reactivation.
    suspendedAt: {
        type: Date,
        default: null
    },
    suspensionReason: {
        type: String,
        default: null
    },
    // Per-Tenant Payment Gateway Integration — the agency's OWN connected
    // payment account(s), so a customer's payment lands directly in the
    // agency's own merchant account, never in a Maqvera-owned one. Array
    // (not a single field) so Stripe today and HyperPay/PayPal later need
    // no schema migration. Distinct from `TenantBillingAccountModel`
    // (Enterprise Subscription Platform) — that model holds the agency's
    // OWN payment method for paying MAQVERA's subscription fee; this field
    // holds the agency's connected account for RECEIVING their own
    // customers' payments. Never confuse the two.
    paymentGateways: [{
        provider: { type: String, enum: ["stripe", "hyperpay", "paypal"], required: true },
        // e.g. Stripe's acct_xxx — never a bank account or card number.
        accountId: { type: String, required: true },
        status: { type: String, enum: ["pending", "connected", "disconnected"], default: "pending" },
        // Stripe Connect: whether the account can actually accept charges/receive payouts yet.
        chargesEnabled: { type: Boolean, default: false },
        payoutsEnabled: { type: Boolean, default: false },
        connectedAt: { type: Date, default: null },
        disconnectedAt: { type: Date, default: null }
    }]
}, {
    timestamps: true,
    // Real optimistic locking on the one field that decides whether an
    // entire tenant can log in at all — TenantSubscriptionService always
    // findOne()s then .save()s this document, never findOneAndUpdate
    // (scripts/seedAuthDomain.js's own one-time findOneAndUpdate call is
    // unaffected either way — it doesn't participate in the version
    // check, same as before this flag existed).
    optimisticConcurrency: true
});

const TenantModel = mongoose.model("tenant", TenantSchema);

export default TenantModel;