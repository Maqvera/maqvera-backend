import { getConcurrencyConfig } from "./concurrencyConfig.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { AppError, sendStandardError } from "./errorContract.js";

// Enterprise Architecture Hardening Phase — Optimistic Locking Standard
// (Improvement 2). Builds directly on Improvement 1's Standard Metadata
// Model: every model that adopts `applyEnterpriseMetadata`
// (utils/enterpriseMetadata.js) already has a real, atomically-incrementing
// `__v` counter (Mongoose's own `optimisticConcurrency`); this file is the
// real enforcement layer on top of that counter — extracting the client's
// claimed version, performing the actual compare-and-swap update, and
// producing the spec's own standardized 409 VERSION_CONFLICT response.
//
// Deliberately NOT wired into any existing controller in this pass — same
// "global standard first, module-by-module adoption after" approach as
// Improvement 1 (see docs/07-enterprise-standards/02-optimistic-locking.md
// "Adoption"). Real, tested (tests/optimisticLockingStandard.test.js)
// infrastructure ready for any update endpoint to opt into.

// Enterprise Standard Error Contract (Improvement 4) — both errors are
// real `AppError`s now (category "Concurrency", catalog-backed httpStatus/
// message via utils/errorContract.js) rather than a parallel, one-off
// error shape. `sendVersionConflict` below builds the full standard
// payload (code/category/severity/httpStatus/correlationId/timestamp)
// instead of the smaller ad hoc object this file used before Improvement
// 4 existed.
export class VersionConflictError extends AppError {
  constructor(message, currentVersion) {
    super("VERSION_CONFLICT", { message });
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export class VersionRequiredError extends AppError {
  constructor(message) {
    super("VERSION_REQUIRED", { message });
    this.name = "VersionRequiredError";
  }
}

/**
 * Reads the client's claimed version from either the standard body
 * contract (`{ version: 8 }`) or the enterprise-REST alternative
 * (`If-Match: "8"`, the same convention Microsoft/Oracle Cloud/SharePoint
 * use) — body wins if both are somehow present. Returns `null` when
 * neither is supplied (never a fabricated default like 0 or the current
 * DB value, which would silently defeat the whole point of the check).
 */
export const extractRequestedVersion = (req) => {
  if (req?.body?.version !== undefined && req.body.version !== null && req.body.version !== "") {
    const parsed = Number(req.body.version);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const ifMatch = req?.header?.("If-Match") || req?.headers?.["if-match"];
  if (ifMatch) {
    const parsed = Number(String(ifMatch).replace(/^W\//, "").replace(/"/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** "Posted financial records remain immutable and are excluded from optimistic locking" — real, config-driven (utils/concurrencyConfig.js). */
export const assertMutableResource = (resourceType) => {
  if (!resourceType) return;
  const config = getConcurrencyConfig();
  if (config.immutableResourceTypes.includes(resourceType)) {
    throw new Error(`${resourceType} is an immutable, append-only resource type and does not support updates or optimistic locking.`);
  }
};

/**
 * The real compare-and-swap: a stale `requestedVersion` can never win a
 * race against a concurrent update, because the version check and the
 * write happen in the SAME atomic `findOneAndUpdate` — there is no
 * separate "read current version, then write" window for a second
 * request to land in between (the exact TOCTOU gap a naive "check then
 * save" implementation would still have).
 *
 * - `requestedVersion` missing -> throws `VersionRequiredError` (400).
 * - Document doesn't exist at all -> throws a plain `Error` containing
 *   "not found" (every controller in this codebase already maps that
 *   substring to 404 — see CLAUDE.md's controller error-mapping convention).
 * - Document exists but its current `__v` differs -> throws
 *   `VersionConflictError` (409) carrying the real `currentVersion`, and
 *   audit-logs the conflict with its `correlationId` ("Every version
 *   conflict MUST be audit logged with its correlationId").
 * - Match -> the update is applied and `__v` increments, atomically.
 */
export const applyOptimisticUpdate = async ({ Model, filter, requestedVersion, update, resourceType = null, tenantId = null, correlationId = null, userId = null }) => {
  assertMutableResource(resourceType);
  if (requestedVersion === null || requestedVersion === undefined) throw new VersionRequiredError();

  const updated = await Model.findOneAndUpdate(
    { ...filter, __v: requestedVersion },
    { ...update, $inc: { __v: 1 } },
    { new: true }
  );
  if (updated) return updated;

  const current = await Model.findOne(filter).lean();
  if (!current) throw new Error(`${resourceType || "Resource"} not found.`);

  await AuditLogModel.create({
    action: "concurrency.version_conflict",
    outcome: "conflict",
    reason: "Supplied version does not match the current version.",
    userId: userId || null,
    tenantId: tenantId || null,
    requestId: correlationId || undefined,
    module: "EnterpriseConcurrencyControl",
    resource: resourceType || null,
    resourceId: String(current._id),
    details: { requestedVersion, currentVersion: current.__v }
  });

  throw new VersionConflictError("Resource has been modified by another user.", current.__v);
};

/** Standard Error Contract 409 envelope — `data: { code: "VERSION_CONFLICT", category: "Concurrency", severity, httpStatus, correlationId, timestamp, currentVersion }`. */
export const sendVersionConflict = (res, error, requestId) => {
  return sendStandardError(res, error, requestId, { currentVersion: error.currentVersion });
};

/**
 * Optional Express middleware for routes that want to reject a
 * missing/malformed version before any business logic runs at all:
 * `router.put("/:id", requireVersion(), validate(...), updateHandler)`.
 * Not mounted anywhere in this pass — real, ready-to-use infrastructure
 * for the deliberate, separate per-route adoption pass.
 */
export const requireVersion = () => (req, res, next) => {
  const version = extractRequestedVersion(req);
  if (version === null) {
    return sendStandardError(res, new VersionRequiredError(), req.requestId);
  }
  req.requestedVersion = version;
  next();
};
