import mongoose from "mongoose";

const BranchSchema = new mongoose.Schema({
    branchKey: {
        type: String,
        required: true,
        index: true
    },
    tenantKey: {
        type: String,
        required: true,
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
    }
}, { timestamps: true });

// branchKey is unique per tenant, not globally — every tenant's first branch
// is named "MAIN" (see controllers/Auth.js SetupTenant), so a global-unique
// constraint here would make self-service onboarding fail for every tenant
// after the first (same bug class as the pre-fix global-unique Role.name).
BranchSchema.index({ tenantKey: 1, branchKey: 1 }, { unique: true });

const BranchModel = mongoose.model("branch", BranchSchema);

export default BranchModel;