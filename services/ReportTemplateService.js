import mongoose from "mongoose";
import ReportTemplateModel from "../models/ReportTemplateModel.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Reporting Platform Part 8 fix — CRUD + resolution for ReportTemplateModel.
 * `resolveTemplate` is the one method ReportExportService.js's PDF path
 * calls: an "Active" template for the exact tenant+reportType+locale wins;
 * failing that, the tenant's "Active" `en` variant of the same reportType;
 * failing that, `null` — the caller falls back to its existing file-based
 * template, so a tenant that never registers a DB template renders exactly
 * as it did before this file existed. Guarded on `readyState === 1` (same
 * convention as SearchEngineService.js's audit-log writes) so callers with
 * no live Mongo connection — most of this repo's test suite — get the
 * fallback path instead of a connection error.
 */
class ReportTemplateService {
  static async resolveTemplate({ tenantId, reportType, locale = "en" }) {
    if (!tenantId || !reportType || mongoose.connection?.readyState !== 1) return null;

    const exact = await ReportTemplateModel.findOne({ tenantId, reportType, locale, status: "Active" }).lean();
    if (exact) return exact;
    if (locale === "en") return null;

    return ReportTemplateModel.findOne({ tenantId, reportType, locale: "en", status: "Active" }).lean();
  }

  static async createTemplate({ tenantId, templateKey, reportType, locale = "en", htmlBody, brandingConfig = {}, userId = null }) {
    if (!tenantId || !templateKey || !reportType || !htmlBody) {
      throw new Error("Missing required template fields (tenantId, templateKey, reportType, htmlBody).");
    }

    const existing = await ReportTemplateModel.findOne({ tenantId, templateKey, locale }).lean();
    if (existing) throw new Error(`A "${locale}" variant of report template ${templateKey} already exists.`);

    const template = await ReportTemplateModel.create({
      tenantId, templateKey, reportType, locale, htmlBody, brandingConfig,
      status: "Draft", version: 1, createdBy: userId, updatedBy: userId
    });

    publishEvent("ReportTemplateCreated", { tenantId, templateKey, locale });
    return template;
  }

  static async updateTemplate({ tenantId, templateKey, locale = "en", htmlBody, brandingConfig, userId = null }) {
    const template = await ReportTemplateModel.findOne({ tenantId, templateKey, locale });
    if (!template) throw new Error(`Report template "${templateKey}" (${locale}) not found.`);

    if (htmlBody !== undefined) template.htmlBody = htmlBody;
    if (brandingConfig !== undefined) template.brandingConfig = brandingConfig;
    template.version += 1;
    template.updatedBy = userId;
    await template.save();

    publishEvent("ReportTemplateUpdated", { tenantId, templateKey, locale, version: template.version });
    return template;
  }

  static async setStatus({ tenantId, templateKey, locale = "en", status, userId = null }) {
    if (!["Draft", "Active", "Archived"].includes(status)) throw new Error(`Invalid template status "${status}".`);

    const template = await ReportTemplateModel.findOneAndUpdate(
      { tenantId, templateKey, locale },
      { $set: { status, updatedBy: userId } },
      { new: true }
    );
    if (!template) throw new Error(`Report template "${templateKey}" (${locale}) not found.`);

    publishEvent("ReportTemplateStatusChanged", { tenantId, templateKey, locale, status });
    return template;
  }

  static async listTemplates({ tenantId, reportType = null, status = null, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (reportType) query.reportType = reportType;
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [templates, total] = await Promise.all([
      ReportTemplateModel.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      ReportTemplateModel.countDocuments(query)
    ]);
    return { templates, total, page, limit };
  }

  static async getTemplate({ tenantId, templateKey, locale = "en" }) {
    const template = await ReportTemplateModel.findOne({ tenantId, templateKey, locale }).lean();
    if (!template) throw new Error(`Report template "${templateKey}" (${locale}) not found.`);
    return template;
  }
}

export default ReportTemplateService;
