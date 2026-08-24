import ReportCatalogModel from "../models/ReportCatalogModel.js";
import { getDashboardConfig } from "../utils/dashboardConfig.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Reporting Platform Part 2 fix — CRUD + lifecycle transitions for
 * ReportCatalogModel. `registerCatalogEntry` is idempotent (upsert on
 * {tenantId,reportKey}) so scripts/seedReportCatalog.js can be re-run
 * safely. `transitionLifecycle` only allows moving forward one step at a
 * time through `reportLifecycleStates` (draft->review->published->
 * deprecated->archived->retired) unless `adminOverride` is passed —
 * mirrors KPIDefinitionService/ReportTemplateService's plain
 * Error-throwing convention (no custom error classes).
 */
class ReportCatalogService {
  static async registerCatalogEntry({ tenantId, reportKey, name, module, category = null, tags = [], owner = null, description = null, lifecycleState = "draft", relatedKpiKeys = [], userId = null }) {
    if (!tenantId || !reportKey || !name || !module) {
      throw new Error("Missing required report catalog fields (tenantId, reportKey, name, module).");
    }

    const config = getDashboardConfig();
    if (!config.dashboardModules.includes(module)) throw new Error(`Invalid module "${module}".`);
    if (!config.reportLifecycleStates.includes(lifecycleState)) throw new Error(`Invalid lifecycleState "${lifecycleState}".`);

    const existing = await ReportCatalogModel.findOne({ tenantId, reportKey });
    if (existing) {
      existing.name = name;
      existing.module = module;
      if (category !== null) existing.category = category;
      if (tags && tags.length > 0) existing.tags = tags;
      if (owner !== null) existing.owner = owner;
      if (description !== null) existing.description = description;
      if (relatedKpiKeys && relatedKpiKeys.length > 0) existing.relatedKpiKeys = relatedKpiKeys;
      existing.updatedBy = userId;
      await existing.save();
      return existing;
    }

    const entry = await ReportCatalogModel.create({
      tenantId, reportKey, name, module, category, tags, owner, description, lifecycleState,
      currentVersion: 1, relatedKpiKeys, createdBy: userId, updatedBy: userId
    });

    publishEvent("ReportCatalogEntryRegistered", { tenantId, reportKey, module });
    return entry;
  }

  static async listCatalogEntries({ tenantId, module = null, lifecycleState = null, tag = null, page = 1, limit = 50 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (module) query.module = module;
    if (lifecycleState) query.lifecycleState = lifecycleState;
    if (tag) query.tags = tag;

    const skip = (page - 1) * limit;
    const [entries, total] = await Promise.all([
      ReportCatalogModel.find(query).sort({ module: 1, reportKey: 1 }).skip(skip).limit(limit).lean(),
      ReportCatalogModel.countDocuments(query)
    ]);
    return { entries, total, page, limit };
  }

  static async getCatalogEntry({ tenantId, reportKey }) {
    const entry = await ReportCatalogModel.findOne({ tenantId, reportKey }).lean();
    if (!entry) throw new Error(`Report catalog entry "${reportKey}" not found.`);
    return entry;
  }

  static async transitionLifecycle({ tenantId, reportKey, lifecycleState, adminOverride = false, userId = null }) {
    const config = getDashboardConfig();
    if (!config.reportLifecycleStates.includes(lifecycleState)) throw new Error(`Invalid lifecycleState "${lifecycleState}".`);

    const entry = await ReportCatalogModel.findOne({ tenantId, reportKey });
    if (!entry) throw new Error(`Report catalog entry "${reportKey}" not found.`);

    if (!adminOverride) {
      const currentIndex = config.reportLifecycleStates.indexOf(entry.lifecycleState);
      const nextIndex = config.reportLifecycleStates.indexOf(lifecycleState);
      if (nextIndex !== currentIndex + 1) {
        throw new Error(`Invalid lifecycle transition from "${entry.lifecycleState}" to "${lifecycleState}". Must advance one step at a time (or pass adminOverride).`);
      }
    }

    entry.lifecycleState = lifecycleState;
    entry.updatedBy = userId;
    await entry.save();

    publishEvent("ReportCatalogLifecycleChanged", { tenantId, reportKey, lifecycleState });
    return entry;
  }
}

export default ReportCatalogService;
