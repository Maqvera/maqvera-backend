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
    // Human-readable label only (e.g. "Sales Manager", "Visa Officer") —
    // access control is entirely driven by `permissions`, never by scope/
    // branch. See docs/06-external-integrations/03-final-architecture-no-branches-rbac.md.
    description: {
        type: String,
        default: null
    },
    // System roles (e.g. the "Administrator" role every tenant is seeded
    // with at setup) cannot be deleted via the Role management API, though
    // their permission set can still be edited.
    isSystemRole: {
        type: Boolean,
        default: false
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