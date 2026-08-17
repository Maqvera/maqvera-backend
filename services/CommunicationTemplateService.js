import CommunicationTemplateModel from "../models/CommunicationTemplateModel.js";

/**
 * Enterprise Communication Platform — Template Engine Service
 * Manages message templates across Email, SMS, WhatsApp, Push, InApp, and Webhook channels.
 * Supports dynamic {{variable}} interpolation.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class CommunicationTemplateService {
  static generateId(prefix = "TPL") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  static async createTemplate({
    tenantId,
    name,
    channel,
    subjectTemplate = "",
    bodyTemplate,
    variables = [],
    userId = null
  }) {
    if (!tenantId || !name || !channel || !bodyTemplate) {
      throw new Error("Missing required template fields (tenantId, name, channel, bodyTemplate).");
    }

    const template = new CommunicationTemplateModel({
      tenantId,
      templateId: this.generateId("TPL"),
      name,
      channel,
      subjectTemplate,
      bodyTemplate,
      variables,
      status: "Active",
      version: 1,
      createdBy: userId
    });

    await template.save();
    return template;
  }

  static async listTemplates({ tenantId, channel, status = "Active", page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (channel) query.channel = channel;
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      CommunicationTemplateModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunicationTemplateModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  static async getTemplateById({ tenantId, templateId }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");
    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId }).lean();
    if (!template) throw new Error(`Communication template ${templateId} not found.`);
    return template;
  }

  static async updateTemplate({ tenantId, templateId, updates = {}, userId = null }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");

    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId });
    if (!template) throw new Error(`Communication template ${templateId} not found.`);

    if (updates.name) template.name = updates.name;
    if (updates.subjectTemplate !== undefined) template.subjectTemplate = updates.subjectTemplate;
    if (updates.bodyTemplate) template.bodyTemplate = updates.bodyTemplate;
    if (updates.variables) template.variables = updates.variables;
    if (updates.status) template.status = updates.status;
    template.version += 1;

    await template.save();
    return template;
  }

  /**
   * Render template by interpolating dynamic {{variable}} strings
   */
  static renderTemplate(templateString = "", data = {}) {
    if (!templateString) return "";
    return templateString.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key) => {
      const value = key.split('.').reduce((obj, prop) => (obj && obj[prop] !== undefined ? obj[prop] : null), data);
      return value !== null && value !== undefined ? String(value) : match;
    });
  }
}

export default CommunicationTemplateService;
