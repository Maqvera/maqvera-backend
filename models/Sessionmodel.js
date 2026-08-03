import mongoose from "mongoose";

const SessionSchema = new mongoose.Schema({
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
    tenantId: {
        type: String,
        default: null,
        index: true
    },
    branchId: {
        type: String,
        default: null,
        index: true
    },
    refreshTokenHash: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ["active", "revoked", "expired"],
        default: "active",
        index: true
    },
    rememberMe: {
        type: Boolean,
        default: false
    },
    deviceId: {
        type: String,
        default: null
    },
    userAgent: {
        type: String,
        default: null
    },
    ipAddress: {
        type: String,
        default: null
    },
    browser: {
        type: String,
        default: null
    },
    os: {
        type: String,
        default: null
    },
    deviceType: {
        type: String,
        enum: ["desktop", "mobile", "tablet", "other"],
        default: "other",
        index: true
    },
    country: {
        type: String,
        default: null
    },
    city: {
        type: String,
        default: null
    },
    lastActivityAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        required: true,
        index: true
    },
    revokedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

SessionSchema.index({ userId: 1, status: 1, lastActivityAt: -1 });

const SessionModel = mongoose.model("session", SessionSchema);

export default SessionModel;