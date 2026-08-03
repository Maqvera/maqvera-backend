import mongoose from "mongoose";

const PasswordResetTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        required: true,
        index: true
    },
    email: {
        type: String,
        required: true,
        index: true
    },
    tokenHash: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: true
    },
    usedAt: {
        type: Date,
        default: null
    },
    active: {
        type: Boolean,
        default: true,
        index: true
    }
}, { timestamps: true });

PasswordResetTokenSchema.index({ userId: 1, active: 1, expiresAt: 1 });

const PasswordResetTokenModel = mongoose.model("password_reset_token", PasswordResetTokenSchema);

export default PasswordResetTokenModel;