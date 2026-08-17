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
    }
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