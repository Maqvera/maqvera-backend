import KPIDefinitionModel from "../models/KPIDefinitionModel.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Reporting Platform Part 5 fix — CRUD + registration for
 * KPIDefinitionModel. `registerDefinition` is idempotent (upsert on
 * {tenantId,kpiKey,ownerModule}) so services/KPIEngine.js's
 * ensureDefinitionsSeeded can call it on every refresh without creating
 * duplicates or clobbering a tenant's own target/thresholds edits. No
 * readyState guard here — mirrors ReportTemplateService.createTemplate's
 * convention (only a read-resolution path like resolveTemplate gets that
 * guard); the one caller that can run without a live DB
 * (KPIEngine.ensureDefinitionsSeeded) already checks readyState itself
 * before calling this at all.
 */
class KPIDefinitionService {
  static async registerDefinition({ tenantId = null, kpiKey, name, ownerModule, category = null, codeRef, description = null, unit = null, target = null, thresholds = {}, userId = null }) {
    if (!kpiKey || !name || !ownerModule || !codeRef) {
      throw new Error("Missing required KPI definition fields (kpiKey, name, ownerModule, codeRef).");
    }

    const existing = await KPIDefinitionModel.findOne({ tenantId, kpiKey, ownerModule });
    if (existing) {
      existing.codeRef = codeRef;
      existing.name = name;
      if (category !== null) existing.category = category;
      if (description !== null) existing.description = description;
      if (unit !== null) existing.unit = unit;
      if (target !== null) existing.target = target;
      if (thresholds && Object.keys(thresholds).length > 0) existing.thresholds = { ...existing.thresholds, ...thresholds };
      existing.updatedBy = userId;
      await existing.save();
      return existing;
    }

    const definition = await KPIDefinitionModel.create({
      tenantId, kpiKey, name, ownerModule, category, codeRef, description, unit, target, thresholds,
      status: "Active", version: 1, createdBy: userId, updatedBy: userId
    });

    publishEvent("KPIDefinitionRegistered", { tenantId, kpiKey, ownerModule });
    return definition;
  }

  static async listDefinitions({ tenantId, ownerModule = null, status = null, page = 1, limit = 50 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId: { $in: [tenantId, null] } };
    if (ownerModule) query.ownerModule = ownerModule;
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [definitions, total] = await Promise.all([
      KPIDefinitionModel.find(query).sort({ ownerModule: 1, kpiKey: 1 }).skip(skip).limit(limit).lean(),
      KPIDefinitionModel.countDocuments(query)
    ]);
    return { definitions, total, page, limit };
  }

  static async getDefinition({ tenantId, kpiKey, ownerModule }) {
    const definition = await KPIDefinitionModel.findOne({
      $or: [{ tenantId, kpiKey, ownerModule }, { tenantId: null, kpiKey, ownerModule }]
    }).sort({ tenantId: -1 }).lean();
    if (!definition) throw new Error(`KPI definition "${kpiKey}" (${ownerModule}) not found.`);
    return definition;
  }

  static async deprecateDefinition({ tenantId, kpiKey, ownerModule, userId = null }) {
    const definition = await KPIDefinitionModel.findOneAndUpdate(
      { tenantId, kpiKey, ownerModule },
      { $set: { status: "Deprecated", updatedBy: userId } },
      { new: true }
    );
    if (!definition) throw new Error(`KPI definition "${kpiKey}" (${ownerModule}) not found for this tenant.`);

    publishEvent("KPIDefinitionDeprecated", { tenantId, kpiKey, ownerModule });
    return definition;
  }
}

export default KPIDefinitionService;
