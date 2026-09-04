import dotenv from "dotenv";

dotenv.config();

// Enterprise Architecture Hardening Phase — Idempotency Standard
// (Improvement 3). "Retention Policy — Minimum 24 Hours, Recommended 72
// Hours, Configurable up to 30 Days." `IDEMPOTENCY_KEY_TTL_SECONDS` stays
// the same env var `models/IdempotencyKeyModel.js` already read directly
// before this standard — moved into its own config file (this codebase's
// standard `getXConfig()` shape) and clamped to the spec's own floor/
// ceiling rather than accepting any value blindly. Default raised from
// the pre-existing 24h to the spec's own "Recommended" 72h — a retention
// tuning change, not a functional/business-logic one (no test in this
// codebase observes real TTL expiry).
const MIN_TTL_SECONDS = 86400; // 24 hours
const MAX_TTL_SECONDS = 2592000; // 30 days
const DEFAULT_TTL_SECONDS = 259200; // 72 hours

export const getIdempotencyConfig = () => {
  const raw = Number.parseInt(process.env.IDEMPOTENCY_KEY_TTL_SECONDS, 10);
  const ttlSeconds = Number.isFinite(raw) ? Math.min(Math.max(raw, MIN_TTL_SECONDS), MAX_TTL_SECONDS) : DEFAULT_TTL_SECONDS;
  return { ttlSeconds };
};

export default getIdempotencyConfig;
