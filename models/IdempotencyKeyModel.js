import mongoose from "mongoose";
import { getIdempotencyConfig } from "../utils/idempotencyConfig.js";

const { ttlSeconds } = getIdempotencyConfig();

const IdempotencyKeySchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true
  },
  idempotencyKey: {
    type: String,
    required: true
  },
  requestPath: {
    type: String,
    default: null
  },
  // "The server MUST store the request hash... Reusing the same key with
  // a different payload MUST return HTTP 409 Conflict." SHA-256 over the
  // request body — computed and compared by middleware/idempotency.js.
  requestHash: {
    type: String,
    required: true
  },
  // Optional — mirrors utils/enterpriseMetadata.js's own opt-in
  // merchantAccountId field. Most financial endpoints have no merchant
  // account in their request body at all; when one is present it's
  // recorded here for audit/record purposes, but the real isolation
  // boundary stays tenantId (see the compound unique index below) —
  // consistent with this codebase's "tenant is the only isolation
  // boundary" architecture (utils/accessScope.js).
  merchantAccountId: {
    type: String,
    default: null
  },
  // The same req.requestId every response/log line already carries
  // (middleware/requestContext.js) — echoed back on both a replay and a
  // 409 conflict response.
  correlationId: {
    type: String,
    default: null
  },
  responseStatusCode: {
    type: Number,
    required: true
  },
  responseBody: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: ttlSeconds
  }
});

IdempotencyKeySchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });

const IdempotencyKeyModel = mongoose.model("idempotency_key", IdempotencyKeySchema);

export default IdempotencyKeyModel;
