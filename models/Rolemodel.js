import mongoose from "mongoose";

const RoleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    permissions: [{
        type: String,
        required: true
    }],
    status: {
        type: String,
        enum: ["active", "inactive"],
        default: "active"
    }
}, { timestamps: true });

const RoleModel = mongoose.model("role", RoleSchema);

export default RoleModel;