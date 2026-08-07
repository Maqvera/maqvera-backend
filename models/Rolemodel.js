import mongoose from "mongoose";

const RoleSchema = new mongoose.Schema({
    tenantId: {
        type: String,
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        index: true
    },
    permissions: [{
        type: String,
        required: true
    }],
    // "branch" (default): the role can only access data in req.auth.branchId.
    // "tenant": the role can access every branch within its own tenant, but
    // never crosses into another tenant. See utils/accessScope.js.
    scope: {
        type: String,
        enum: ["branch", "tenant"],
        default: "branch"
    },
    status: {
        type: String,
        enum: ["active", "inactive"],
        default: "active"
    }
}, { timestamps: true });

// Role names are unique per tenant, not globally — each tenant owns and can
// independently customize its own role catalog (see utils/authDomainDefaults.js
// for the seeded default "Administrator" role every new tenant gets at setup).
RoleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const RoleModel = mongoose.model("role", RoleSchema);

export default RoleModel;