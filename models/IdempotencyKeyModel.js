import mongoose from "mongoose";

const IDEMPOTENCY_KEY_TTL_SECONDS = Number.parseInt(process.env.IDEMPOTENCY_KEY_TTL_SECONDS || "86400", 10) || 86400;

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
    expires: IDEMPOTENCY_KEY_TTL_SECONDS
  }
});

IdempotencyKeySchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });

const IdempotencyKeyModel = mongoose.model("idempotency_key", IdempotencyKeySchema);

export default IdempotencyKeyModel;
