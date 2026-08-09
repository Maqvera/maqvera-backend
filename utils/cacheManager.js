import logger from "./logger.js";

// ─────────────────────────────────────────────────────────────
// Configuration — all values from environment, zero hardcoding
// ─────────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "";
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "maqvera:";
const DEFAULT_TTL_SECONDS = parseInt(process.env.DASHBOARD_CACHE_TTL_SECONDS, 10) || 60;

// ─────────────────────────────────────────────────────────────
// In-Memory Fallback Store
// ─────────────────────────────────────────────────────────────
const memoryStore = new Map();

const memoryAdapter = {
  name: "memory",

  async get(key) {
    const entry = memoryStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      memoryStore.delete(key);
      return null;
    }
    return entry.value;
  },

  async set(key, value, ttlSeconds) {
    memoryStore.set(key, {
      value,
      expiresAt: Date.now() + (ttlSeconds * 1000),
    });
  },

  async del(key) {
    memoryStore.delete(key);
  },

  async delPattern(pattern) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    for (const key of memoryStore.keys()) {
      if (regex.test(key)) memoryStore.delete(key);
    }
  },

  async flush() {
    memoryStore.clear();
  },

  async isHealthy() {
    return true;
  },
};

// ─────────────────────────────────────────────────────────────
// Redis Adapter — lazy-initialized only when REDIS_URL is set
// ─────────────────────────────────────────────────────────────
let redisAdapter = null;

async function buildRedisAdapter() {
  if (!REDIS_URL) return null;
  try {
    const Redis = (await import("ioredis")).default;
    const client = new Redis(REDIS_URL, {
      keyPrefix: KEY_PREFIX,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying after 5 attempts
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    await client.connect();
    logger.info("Redis cache connected successfully.");

    client.on("error", (err) => {
      logger.error("Redis connection error, falling back to memory cache.", { error: err.message });
    });

    return {
      name: "redis",
      _client: client,

      async get(key) {
        try {
          const raw = await client.get(key);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },

      async set(key, value, ttlSeconds) {
        try {
          await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
        } catch { /* swallow — fallback is fine */ }
      },

      async del(key) {
        try {
          await client.del(key);
        } catch { /* swallow */ }
      },

      async delPattern(pattern) {
        try {
          const fullPattern = KEY_PREFIX + pattern;
          let cursor = "0";
          do {
            const [nextCursor, keys] = await client.scan(cursor, "MATCH", fullPattern, "COUNT", 100);
            cursor = nextCursor;
            if (keys.length > 0) {
              // strip prefix because ioredis adds it automatically
              const stripped = keys.map((k) => k.startsWith(KEY_PREFIX) ? k.slice(KEY_PREFIX.length) : k);
              await client.del(...stripped);
            }
          } while (cursor !== "0");
        } catch { /* swallow */ }
      },

      async flush() {
        try {
          // Only flush keys with our prefix
          await this.delPattern("*");
        } catch { /* swallow */ }
      },

      async isHealthy() {
        try {
          const pong = await client.ping();
          return pong === "PONG";
        } catch {
          return false;
        }
      },
    };
  } catch (err) {
    logger.warn("Redis unavailable, using in-memory cache.", { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// CacheManager — public API
// ─────────────────────────────────────────────────────────────
class CacheManager {
  static _adapter = null;
  static _initialized = false;
  // EXT-033 §12 "Cache Hit Rate." Real, in-process counters — reset on
  // restart, same honesty scope as AIToolRateLimiter's own in-memory
  // windows elsewhere in this codebase (a real signal for this running
  // instance, not a claim of a distributed/cross-instance total). Reflects
  // every consumer of this shared CacheManager, not only AI callers — that
  // fact is stated explicitly wherever AIObservabilityService surfaces it.
  static _hits = 0;
  static _misses = 0;

  /**
   * Initialize the cache — tries Redis first, falls back to memory.
   * Safe to call multiple times; only initializes once.
   */
  static async init() {
    if (this._initialized) return;
    this._initialized = true;

    redisAdapter = await buildRedisAdapter();
    this._adapter = redisAdapter || memoryAdapter;

    logger.info(`CacheManager initialized with backend: ${this._adapter.name}`);
  }

  /** Get the active adapter (memory if init hasn't run yet) */
  static get adapter() {
    return this._adapter || memoryAdapter;
  }

  /**
   * Retrieve a cached value by key.
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  static async get(key) {
    const value = await this.adapter.get(key);
    if (value !== null && value !== undefined) this._hits += 1;
    else this._misses += 1;
    return value;
  }

  /** EXT-033 §12 "Cache Hit Rate" — real counters since process start. */
  static getStats() {
    const total = this._hits + this._misses;
    return { hits: this._hits, misses: this._misses, total, hitRatePct: total > 0 ? Number(((this._hits / total) * 100).toFixed(1)) : null, backend: this.backendName };
  }

  /**
   * Store a value in the cache.
   * @param {string} key
   * @param {any}    value
   * @param {number} [ttlSeconds] — defaults to DASHBOARD_CACHE_TTL_SECONDS env var
   */
  static async set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
    return this.adapter.set(key, value, ttlSeconds);
  }

  /**
   * Invalidate a single key.
   * @param {string} key
   */
  static async invalidate(key) {
    return this.adapter.del(key);
  }

  /**
   * Invalidate all keys matching a glob pattern.
   * @param {string} pattern — e.g. "dashboard:*:tenant123:*"
   */
  static async invalidatePattern(pattern) {
    return this.adapter.delPattern(pattern);
  }

  /**
   * Flush all cached data (use with caution).
   */
  static async flush() {
    return this.adapter.flush();
  }

  /**
   * Health check — returns true if the cache backend is reachable.
   */
  static async isHealthy() {
    return this.adapter.isHealthy();
  }

  /**
   * Get-or-compute helper. Returns cached data if available,
   * otherwise computes via the provided function and caches the result.
   * @param {string}   key
   * @param {Function} computeFn — async function that returns the fresh value
   * @param {number}   [ttlSeconds]
   * @returns {Promise<{ data: any, fromCache: boolean }>}
   */
  static async getOrCompute(key, computeFn, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const cached = await this.get(key);
    if (cached !== null && cached !== undefined) {
      return { data: cached, fromCache: true };
    }

    const freshData = await computeFn();
    await this.set(key, freshData, ttlSeconds);
    return { data: freshData, fromCache: false };
  }

  /**
   * Returns the name of the active backend ("redis" | "memory").
   */
  static get backendName() {
    return this.adapter.name;
  }
}

export default CacheManager;
