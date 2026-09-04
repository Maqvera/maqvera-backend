import mongoose from "mongoose";

// Enterprise Architecture Hardening Phase — API Version Strategy Standard
// (Improvement 8). "Maintain a central registry" — the spec's own
// `API | Version | Status | Supported Until` table, made real and
// queryable. `apiName` is a human-scoped label (e.g. "Payments",
// "Invoices", "Organisation"), NOT a route path — one API can span many
// route files/controllers.
const ApiVersionRegistrySchema = new mongoose.Schema({
  apiName: { type: String, required: true, trim: true },
  version: { type: String, required: true, trim: true }, // e.g. "v1"
  // Config-driven (lifecycleStatuses) — Design, Preview, Beta, GA,
  // Deprecated, Sunset, Retired.
  status: { type: String, required: true, default: "GA" },
  owner: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  releasedAt: { type: Date, default: Date.now },
  // The real support-policy deadline — "Deprecated Version Support 12
  // Months" computed from `deprecatedAt` when not explicitly overridden.
  supportedUntil: { type: Date, default: null },
  deprecatedAt: { type: Date, default: null },
  deprecationReason: { type: String, default: null },
  // Which version a Deprecated caller should migrate to — echoed in the
  // real `Latest-Version` response header.
  latestVersion: { type: String, default: null },
  sunsetAt: { type: Date, default: null },
  retiredAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

ApiVersionRegistrySchema.index({ apiName: 1, version: 1 }, { unique: true });
ApiVersionRegistrySchema.index({ status: 1 });

ApiVersionRegistrySchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ApiVersionRegistryModel = mongoose.model("api_version_registry", ApiVersionRegistrySchema);

export default ApiVersionRegistryModel;
