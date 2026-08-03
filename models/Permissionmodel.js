import mongoose from "mongoose";

const PermissionSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    description: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ["active", "inactive"],
        default: "active"
    }
}, { timestamps: true });

const PermissionModel = mongoose.model("permission", PermissionSchema);

export default PermissionModel;