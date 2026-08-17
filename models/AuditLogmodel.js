import mongoose from "mongoose";
import { getCorrelationId } from "../utils/correlationContext.js";

const AuditLogSchema = new mongoose.Schema({
    action: {
        type: String,
        required: true,
        index: true
    },
    outcome: {
        type: String,
        required: true,
        default: "success",
        index: true
    },
    reason: {
        type: String,
        default: null
    },
    userId: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
        index: true
    },
    email: {
        type: String,
        default: null,
        index: true
    },
    tenantId: {
        type: String,
        default: null,
        index: true
    },
    sessionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "session",
        default: null,
        index: true
    },
    // Enterprise Correlation & Traceability Standard — "Include
    // Correlation-ID in every audit record." Any call site that already
    // passes its own `requestId` keeps that value untouched; this default
    // only fires when one is omitted, and now prefers the CURRENT
    // request's real correlationId (AsyncLocalStorage — see
    // utils/correlationContext.js) over the old placeholder string, so an
    // audit row created without an explicit requestId still traces back
    // to the real request that caused it. The `system-<timestamp>-<random>`
    // form remains the honest fallback outside any request context (a
    // cron scheduler's own audit entries).
    requestId: {
        type: String,
        required: true,
        default: () => getCorrelationId() || `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        index: true
    },
    ipAddress: {
        type: String,
        default: null
    },
    device: {
        type: String,
        default: null
    },
    browser: {
        type: String,
        default: null
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    // Compatibility fields retained for existing domain services. Keeping
    // them explicit ensures strict-mode Mongoose does not discard audit data.
    module: { type: String, default: null, index: true },
    resource: { type: String, default: null, index: true },
    resourceId: { type: String, default: null, index: true },
    targetId: { type: String, default: null, index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

AuditLogSchema.set("toJSON", {
    transform: (_, ret) => {
        delete ret.__v;
        return ret;
    }
});

const AuditLogModel = mongoose.model("audit_log", AuditLogSchema);

export default AuditLogModel;
