import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Standard Metadata Model
// (Improvement 1 of the hardening queue). "We will not modify each module
// separately at first. Instead we'll first create global enterprise
// standards... then every module simply references these standards
// instead of duplicating them." This file IS that standard's real,
// applicable implementation for MongoDB/Mongoose — a schema plugin +
// request-metadata capture helper, deliberately NOT retrofitted onto any
// existing model in this pass (see docs/07-enterprise-standards/
// 01-standard-metadata.md's own "Adoption" section for why).
//
// Field-by-field mapping from the spec's own `EnterpriseMetadata` example
// to what this codebase already has, so nothing here duplicates existing,
// working infrastructure:
//   id            -> MongoDB's own `_id` (every model already has this)
//   tenantId      -> NOT added by this plugin. Every tenant-owned model
//                    already declares its own `tenantId` (see
//                    utils/accessScope.js) with its own indexing; a
//                    plugin-injected second declaration would risk
//                    colliding with, not standardizing, that.
//   companyId / merchantAccountId / branchId
//                 -> opt-in only (`includeCompany`/`includeMerchant`/
//                    `includeBranch`) — real references into Improvement
//                    3/4's own CORE platforms (MerchantAccountModel,
//                    CompanyModel, BranchModel), added only when a model
//                    actually needs them. branchId here is the same
//                    descriptive-only reference as everywhere else in this
//                    codebase — never added to getAccessScope() or any
//                    access-control filter.
//   createdBy / updatedBy
//                 -> already the near-universal convention across every
//                    model this codebase's recent Improvements have built;
//                    this plugin adds them ONLY when a schema doesn't
//                    already define its own (see `addIfMissing` below).
//   createdAt / updatedAt
//                 -> Mongoose's own `{ timestamps: true }` schema option
//                    (untouched by this plugin — a model opts in the same
//                    way it always has).
//   version       -> Mongoose's own optimistic-concurrency `__v` counter
//                    (`schema.set("optimisticConcurrency", true)`),
//                    already used by every Improvement-3/4/5 model. This
//                    plugin turns it on by default rather than reinventing
//                    a second, manually-incremented counter — real
//                    Optimistic Locking as its own dedicated hardening
//                    item is still queued separately (exposing/enforcing
//                    `version` at the API request layer, e.g. requiring
//                    a client to send back the version it read), this
//                    plugin only guarantees the underlying counter exists.
//                    Call `exposeVersion` from a model's own `toJSON`
//                    transform to surface it as a real `version` field
//                    instead of the internal `__v` name.
//   status        -> NOT force-added — most existing models already
//                    define their own, richer status enum; there is
//                    nothing generic to standardize without conflicting
//                    with those.
//   correlationId -> the same real request id this codebase already
//                    threads through every response/log line
//                    (`middleware/requestContext.js` -> `req.requestId`,
//                    the identical mechanism `controllers/Auth.js`'s own
//                    `getRequestMeta` already reuses as `requestId`) —
//                    deliberately not a second, parallel id generator.
//   sourceSystem / createdFromIP / createdFromDevice
//                 -> real, captured from the request the same way
//                    `controllers/Auth.js`'s own `getRequestMeta` already
//                    captures IP/User-Agent for login/session auditing
//                    (same `x-forwarded-for` -> `req.ip` ->
//                    `req.socket.remoteAddress` precedence) — reimplemented
//                    here at the utils layer (not imported from a
//                    controller, the wrong dependency direction) rather
//                    than duplicated ad hoc per module.

const addIfMissing = (schema, path, definition) => {
  if (!schema.path(path)) schema.add({ [path]: definition });
};

/**
 * Mongoose schema plugin — `schema.plugin(applyEnterpriseMetadata, { includeCompany: true })`.
 * Every field is added only if the schema doesn't already define one with
 * the same name, so applying this to an existing model's schema can never
 * silently override a field it already had.
 */
export const applyEnterpriseMetadata = (schema, options = {}) => {
  const {
    includeCompany = false,
    includeMerchant = false,
    includeBranch = false,
    optimisticConcurrency = true
  } = options;

  addIfMissing(schema, "createdBy", { type: String, default: null });
  addIfMissing(schema, "updatedBy", { type: String, default: null });
  addIfMissing(schema, "correlationId", { type: String, default: null, index: true });
  addIfMissing(schema, "sourceSystem", { type: String, default: null });
  addIfMissing(schema, "createdFromIP", { type: String, default: null });
  addIfMissing(schema, "createdFromDevice", { type: String, default: null });

  if (includeCompany) addIfMissing(schema, "companyId", { type: mongoose.Schema.Types.ObjectId, ref: "org_company", default: null, index: true });
  if (includeMerchant) addIfMissing(schema, "merchantAccountId", { type: mongoose.Schema.Types.ObjectId, ref: "merchant_account", default: null, index: true });
  if (includeBranch) addIfMissing(schema, "branchId", { type: mongoose.Schema.Types.ObjectId, ref: "org_branch", default: null, index: true });

  // Mongoose's own Schema constructor always normalizes
  // `schema.options.optimisticConcurrency` to a concrete boolean (`false`
  // by default) — it is never `undefined` post-construction, so there is
  // no reliable way to distinguish "a model explicitly opted out on its
  // own schema constructor" from "Mongoose's own default" by reading it
  // back. The plugin's own `optimisticConcurrency` option (default
  // `true`) IS the real opt-out surface instead:
  // `schema.plugin(applyEnterpriseMetadata, { optimisticConcurrency: false })`.
  schema.set("optimisticConcurrency", optimisticConcurrency);
};

/** Real request-metadata capture — the correlationId/sourceSystem/createdFromIP/createdFromDevice quarter of the standard. Spread the result into any document at creation time: `{ ...captureRequestMetadata(req), ...otherFields }`. */
export const captureRequestMetadata = (req) => ({
  correlationId: req?.requestId || null,
  sourceSystem: req?.header?.("X-Source-System") || "api",
  createdFromIP: req?.headers?.["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req?.ip || req?.socket?.remoteAddress || null,
  createdFromDevice: req?.header?.("User-Agent") || null
});

/** Renames a document's internal `__v` to the standard's `version` field name in a `toJSON` transform: `schema.set("toJSON", { transform: (doc, ret) => exposeVersion(doc, ret) })`. */
export const exposeVersion = (doc, ret) => {
  ret.version = doc.__v;
  delete ret.__v;
  return ret;
};

export default applyEnterpriseMetadata;
