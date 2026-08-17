import EventRegistryModel from "../models/EventRegistryModel.js";
import { publishEvent } from "./eventBus.js";
import { getCorrelationId } from "./correlationContext.js";
import { AppError, fieldDetailsFromJoiError } from "./errorContract.js";
import { getEventVersioningConfig } from "./eventVersioningConfig.js";
import logger from "./logger.js";

/**
 * Enterprise Event Versioning Standard (Enterprise Architecture Hardening
 * Phase, Improvement 7). A NEW, additive, opt-in publishing path —
 * `utils/eventBus.js`'s own `publishEvent(eventName, payload)` is
 * completely untouched, and every one of this codebase's existing
 * `publishEvent("InvoiceCreated", {...})`-style call sites keeps working
 * byte-for-byte as before. Renaming those hundreds of call sites to
 * `InvoiceCreated.v1` and restructuring their flat payload into a nested
 * `{ data: {...} }` envelope in place would be EXACTLY the breaking
 * change this standard exists to prevent ("Old consumers break ho sakte
 * hain") — done as a mass in-place rewrite instead of a genuine
 * side-by-side version, it would violate the standard while claiming to
 * implement it. `publishVersionedEvent` is real, new infrastructure for
 * this standard's own actual behavior, ready for genuinely NEW events
 * (and a deliberate, later, one-event-at-a-time migration of existing
 * ones — see docs/07-enterprise-standards/07-event-versioning.md
 * "Adoption").
 */

// In-memory only — a Joi schema instance isn't serializable into Mongo.
// `models/EventRegistryModel.js` holds the real, durable
// ownership/lifecycle record this file checks; this Map is the optional
// payload-shape validator a module can register at startup.
const schemaRegistry = new Map();

const schemaKey = (eventName, version) => `${eventName}.v${version}`;

/** A module registers its own event's payload schema once, typically at startup — real validation on every future publish of that exact version, not just documentation. */
export const registerEventSchema = (eventName, version, joiSchema) => {
  schemaRegistry.set(schemaKey(eventName, version), joiSchema);
};

/**
 * Real duplicate-definition prevention: registering the same
 * (eventName, version) again with a DIFFERENT owner/category is a
 * genuine conflict — likely two modules independently claiming the same
 * event name — and is rejected rather than silently overwritten.
 * Re-registering with the SAME owner/category is a safe, idempotent
 * no-op (a service re-declaring its own event on every process start).
 */
export const registerEvent = async (eventName, version, { category, owner, description = null, userId = null }) => {
  const config = getEventVersioningConfig();
  if (!eventName || !version) throw new Error("eventName and version are required.");
  if (!config.eventCategories.includes(category)) throw new Error(`Invalid category "${category}".`);
  if (!owner) throw new Error("owner is required.");

  const existing = await EventRegistryModel.findOne({ eventName, version });
  if (existing) {
    if (existing.owner !== owner || existing.category !== category) {
      throw new AppError("EVENT_REGISTRY_CONFLICT", { details: { eventName, version, registeredOwner: existing.owner, registeredCategory: existing.category } });
    }
    if (description && description !== existing.description) {
      existing.description = description;
      existing.updatedBy = userId || null;
      await existing.save();
    }
    return existing.toJSON();
  }

  // Real race: a brand-new (eventName, version) can be registered by two
  // genuinely concurrent callers at once (e.g. Automation #8's own
  // parallel worker pool, each publishing the same never-before-seen event
  // for a different merchant). The `findOne` above found nothing for
  // either racer; the unique `(eventName, version)` index correctly lets
  // only ONE `create` win — the loser re-fetches and defers to whichever
  // registration actually landed, rather than surfacing a raw duplicate-key
  // error for what is really a benign, idempotent re-registration.
  try {
    const created = await EventRegistryModel.create({ eventName, version, category, owner, description, status: "Active", createdBy: userId || null, updatedBy: userId || null });
    return created.toJSON();
  } catch (error) {
    if (error.code !== 11000) throw error;
    const winner = await EventRegistryModel.findOne({ eventName, version });
    if (!winner) throw error; // genuinely unexpected — surface the original error
    if (winner.owner !== owner || winner.category !== category) {
      throw new AppError("EVENT_REGISTRY_CONFLICT", { details: { eventName, version, registeredOwner: winner.owner, registeredCategory: winner.category } });
    }
    return winner.toJSON();
  }
};

/**
 * The real, versioned publish path — constructs the standard Enterprise
 * Event Envelope (`eventName`, `eventVersion`, tenant/company/merchant
 * identity, `source`, nested `data`) and publishes it under the real
 * `<EventName>.v<N>` key via the existing, untouched `publishEvent` — so
 * `subscribeEvent("InvoiceCreated.v1", listener)` gets the exact same
 * eventId/correlationId stamping and DomainEventModel outbox persistence
 * every other event in this codebase already relies on.
 */
export const publishVersionedEvent = async ({
  eventName, version = 1, data = {}, category, owner, source,
  tenantId = null, merchantAccountId = null, companyId = null, branchId = null,
  correlationId = null, userId = null
}) => {
  if (!eventName) throw new Error("eventName is required.");
  if (!source) throw new Error("source is required.");

  const registryEntry = await registerEvent(eventName, version, { category, owner, userId });

  if (registryEntry.status === "Retired") {
    throw new AppError("EVENT_VERSION_RETIRED", { details: { eventName, version } });
  }
  if (registryEntry.status === "Deprecated") {
    logger.warn(`Publishing a Deprecated event version: ${eventName}.v${version}`, { eventName, version, owner: registryEntry.owner });
  }

  const schema = schemaRegistry.get(schemaKey(eventName, version));
  if (schema) {
    const { error } = schema.validate(data, { abortEarly: false });
    if (error) {
      throw new AppError("VALIDATION_FAILED", { message: `${eventName}.v${version} payload failed schema validation.`, details: fieldDetailsFromJoiError(error) });
    }
  }

  const resolvedCorrelationId = correlationId || getCorrelationId() || null;
  const eventId = publishEvent(`${eventName}.v${version}`, {
    eventName,
    eventVersion: `${version}.0`,
    tenantId, merchantAccountId, companyId, branchId,
    source,
    correlationId: resolvedCorrelationId,
    data
  });

  EventRegistryModel.updateOne({ eventName, version }, { $inc: { publishCount: 1 }, $set: { lastPublishedAt: new Date() } }).catch((err) => logger.error("Event registry publish-count update failed", { eventName, version, error: err.message }));

  return eventId;
};

export const deprecateEventVersion = async (eventName, version, reason, userId) => {
  const entry = await EventRegistryModel.findOne({ eventName, version });
  if (!entry) throw new Error("Event registry entry not found.");
  if (entry.status === "Retired") throw new Error(`Cannot deprecate a Retired event version.`);
  entry.status = "Deprecated";
  entry.deprecatedAt = new Date();
  entry.deprecationReason = reason || null;
  entry.updatedBy = userId || null;
  await entry.save();
  return entry.toJSON();
};

export const retireEventVersion = async (eventName, version, userId) => {
  const entry = await EventRegistryModel.findOne({ eventName, version });
  if (!entry) throw new Error("Event registry entry not found.");
  entry.status = "Retired";
  entry.retiredAt = new Date();
  entry.updatedBy = userId || null;
  await entry.save();
  return entry.toJSON();
};

export const reactivateEventVersion = async (eventName, version, userId) => {
  const entry = await EventRegistryModel.findOne({ eventName, version });
  if (!entry) throw new Error("Event registry entry not found.");
  if (entry.status === "Retired") throw new Error("Cannot reactivate a Retired event version — register a new version instead.");
  entry.status = "Active";
  entry.deprecatedAt = null;
  entry.deprecationReason = null;
  entry.updatedBy = userId || null;
  await entry.save();
  return entry.toJSON();
};

export const listEventRegistry = async (query = {}) => {
  const config = getEventVersioningConfig();
  const filter = {};
  if (query.eventName) filter.eventName = query.eventName;
  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;
  if (query.owner) filter.owner = query.owner;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

  const [items, total] = await Promise.all([
    EventRegistryModel.find(filter).sort({ eventName: 1, version: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    EventRegistryModel.countDocuments(filter)
  ]);
  return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
};

export const getEventRegistryEntry = async (eventName, version) => {
  const entry = await EventRegistryModel.findOne({ eventName, version: parseInt(version, 10) }).lean();
  if (!entry) throw new Error("Event registry entry not found.");
  return entry;
};
