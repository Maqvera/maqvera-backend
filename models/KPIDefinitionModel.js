import mongoose from "mongoose";

/**
 * Reporting Platform Part 5 fix — KPI Management. services/KPIEngine.js's
 * compute*Metrics functions are real, correct, and stay as the single
 * source of truth for the actual math; this model does not re-implement
 * any formula. It exists so a KPI a compute function returns is a
 * discoverable, owned, versioned entity ("code-ref" formulaType — this is
 * a registry over existing JS, not an expression parser) instead of an
 * implicit object key nobody outside KPIEngine.js can see or reason
 * about. `ownerModule` is config-driven via utils/dashboardConfig.js's
 * dashboardModules (the same field models/DashboardPreferenceModel.js and
 * models/DashboardAlertModel.js now use), so a KPI's ownership uses the
 * same vocabulary as which module's dashboard/preference/alert it
 * belongs to.
 */
const KPIDefinitionSchema = new mongoose.Schema({
  // Nullable: a system-seeded default definition (registered by
  // KPIEngine.ensureDefinitionsSeeded) is tenant-agnostic until a tenant
  // customizes its target/thresholds, mirroring how config defaults in
  // utils/*Config.js are global-with-env-override rather than mandatorily
  // per-tenant from day one.
  tenantId: { type: String, default: null, index: true },
  kpiKey: { type: String, required: true, index: true },
  name: { type: String, required: true },
  ownerModule: { type: String, required: true, index: true },
  category: { type: String, default: null },
  // Only "code-ref" exists today — the definition documents/versions an
  // EXISTING JS compute path (`codeRef`), it does not execute a formula
  // string. A real expression-evaluator formulaType is out of scope here
  // (see Report Builder, a separate later epic).
  formulaType: { type: String, required: true, default: "code-ref", enum: ["code-ref"] },
  codeRef: { type: String, required: true },
  description: { type: String, default: null },
  unit: { type: String, default: null },
  target: { type: Number, default: null },
  thresholds: {
    warning: { type: Number, default: null },
    critical: { type: Number, default: null }
  },
  version: { type: Number, default: 1 },
  status: { type: String, default: "Active", enum: ["Active", "Deprecated"], index: true },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

KPIDefinitionSchema.index({ tenantId: 1, kpiKey: 1, ownerModule: 1 }, { unique: true });

KPIDefinitionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const KPIDefinitionModel = mongoose.model("kpi_definition", KPIDefinitionSchema);

export default KPIDefinitionModel;
