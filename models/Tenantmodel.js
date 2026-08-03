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
    }
}, { timestamps: true });

const TenantModel = mongoose.model("tenant", TenantSchema);

export default TenantModel;