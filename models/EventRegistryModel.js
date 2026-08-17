import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — Event Versioning Standard
// (Improvement 7). "Maintain a central registry. This prevents duplicate
// definitions." Real, queryable metadata for every `<EventName>.v<N>`
// this platform publishes — not the Joi schema itself (not serializable
// into Mongo), but the real ownership/lifecycle record
// `utils/eventVersioning.js` checks against before every publish.
const EventRegistrySchema = new mongoose.Schema({
  eventName: { type: String, required: true, trim: true },
  version: { type: Number, required: true, min: 1 },
  // Config-driven (eventCategories) — Domain, Integration, System.
  category: { type: String, required: true },
  owner: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  // Config-driven (eventStatuses) — Active, Deprecated, Retired. Real
  // lifecycle: "Publish v1 -> Publish v2 -> Run Both -> Migration Window
  // -> Deprecate v1 -> Retire v1."
  status: { type: String, required: true, default: "Active" },
  deprecatedAt: { type: Date, default: null },
  deprecationReason: { type: String, default: null },
  retiredAt: { type: Date, default: null },
  // Real usage counters — how many times this exact version has actually
  // been published, and when last — the honest signal for "is anything
  // still consuming this, is it safe to retire."
  publishCount: { type: Number, default: 0 },
  lastPublishedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

EventRegistrySchema.index({ eventName: 1, version: 1 }, { unique: true });
EventRegistrySchema.index({ status: 1, category: 1 });

EventRegistrySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const EventRegistryModel = mongoose.model("event_registry", EventRegistrySchema);

export default EventRegistryModel;
