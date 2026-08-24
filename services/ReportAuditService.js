import crypto from "crypto";
import mongoose from "mongoose";
import ReportAuditEventModel from "../models/ReportAuditEventModel.js";

/**
 * Reporting Platform Part 13 fix (Step 2) — hash-chain computation for
 * ReportAuditEventModel, mirroring services/AuditComplianceService.js's
 * computeEventHash/recordEvent mechanics (per-tenant sequence + previousHash
 * chain, SHA-256 over the event's own canonical fields) but over THIS
 * schema's field set. Guarded on `readyState === 1` (same convention as
 * services/ReportTemplateService.js's resolveTemplate) — never throws with
 * no live DB, matching how the Step-1 AuditLogModel calls this runs
 * alongside are already fire-and-forget.
 */
export const computeReportAuditHash = (event) => {
  const canonical = JSON.stringify({
    tenantId: event.tenantId,
    sequence: event.sequence,
    module: event.module,
    resourceType: event.resourceType,
    resourceKey: event.resourceKey,
    action: event.action,
    userId: event.userId || null,
    timestamp: new Date(event.timestamp).toISOString(),
    previousHash: event.previousHash || null
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
};

class ReportAuditService {
  static async recordEvent({ tenantId, module, resourceType, resourceKey, action, userId = null, userEmail = null, ipAddress = null, format = null, correlationId = null }) {
    if (!tenantId || !module || !resourceType || !resourceKey || !action) return null;
    if (mongoose.connection?.readyState !== 1) return null;

    const last = await ReportAuditEventModel.findOne({ tenantId }).sort({ sequence: -1 }).select("sequence hash").lean();
    const sequence = (last?.sequence || 0) + 1;
    const previousHash = last?.hash || null;
    const timestamp = new Date();

    const hash = computeReportAuditHash({ tenantId, sequence, module, resourceType, resourceKey, action, userId, timestamp, previousHash });

    return ReportAuditEventModel.create({
      tenantId, sequence, previousHash, hash, correlationId,
      module, resourceType, resourceKey, action, userId, userEmail, ipAddress, format,
      timestamp, status: "Active", legalHold: false
    });
  }
}

export default ReportAuditService;
