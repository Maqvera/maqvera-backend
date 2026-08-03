import mongoose from "mongoose";

const BranchSchema = new mongoose.Schema({
    branchKey: {
        type: String,
        required: true,
        unique: true,
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

BranchSchema.index({ tenantKey: 1, branchKey: 1 });

const BranchModel = mongoose.model("branch", BranchSchema);

export default BranchModel;