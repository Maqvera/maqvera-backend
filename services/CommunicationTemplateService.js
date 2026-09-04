import CommunicationTemplateModel from "../models/CommunicationTemplateModel.js";
import CommunicationTemplateVersionModel from "../models/CommunicationTemplateVersionModel.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Enterprise Communication Platform — Template Engine Service
 * Manages message templates across Email, SMS, WhatsApp, Push, InApp, and Webhook channels.
 * Supports dynamic {{variable}} interpolation.
 * Every version of a template is snapshotted to CommunicationTemplateVersionModel — the
 * live document only ever holds the current version, history lives in the version model,
 * which is what makes rollbackTemplate() possible.
 *
 * Part 8 fix — real approval gate (Draft -> PendingApproval -> Active/Rejected) and
 * localization: one logical template (a `templateId`) can have several `locale`
 * variants, each its own document (see the compound unique index on the model).
 * Permission checks for who may submit/approve/reject are the CALLER's
 * responsibility, matching this codebase's convention everywhere else (e.g.
 * utils/archivalService.js) — this service never hardcodes a role-name allowlist.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class CommunicationTemplateService {
  static generateId(prefix = "TPL") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Creates a new logical template (omit `templateId`) or a new locale
   * variant of an existing one (pass the existing `templateId` + a new
   * `locale`). Always starts life as "Draft" — see approveTemplate() for why
   * a template can never reach "Active" straight out of creation.
   */
  static async createTemplate({
    tenantId,
    templateId = null,
    locale = "en",
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

    const resolvedTemplateId = templateId || this.generateId("TPL");

    const existing = await CommunicationTemplateModel.findOne({ tenantId, templateId: resolvedTemplateId, locale }).lean();
    if (existing) throw new Error(`A "${locale}" variant of template ${resolvedTemplateId} already exists.`);

    const template = new CommunicationTemplateModel({
      tenantId,
      templateId: resolvedTemplateId,
      locale,
      name,
      channel,
      subjectTemplate,
      bodyTemplate,
      variables,
      status: "Draft",
      version: 1,
      createdBy: userId
    });

    await template.save();
    await this._snapshotVersion(template);
    publishEvent("CommunicationTemplateCreated", { tenantId, templateId: template.templateId, locale });
    return template;
  }

  static async listTemplates({ tenantId, channel, status = null, locale = null, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (channel) query.channel = channel;
    if (status) query.status = status;
    if (locale) query.locale = locale;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      CommunicationTemplateModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunicationTemplateModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  /**
   * Every locale variant registered for one logical templateId (admin/CRUD view).
   */
  static async listTemplateLocales({ tenantId, templateId }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");
    return CommunicationTemplateModel.find({ tenantId, templateId }).sort({ locale: 1 }).lean();
  }

  /**
   * Admin/CRUD lookup — returns a template regardless of its approval
   * status (Draft/PendingApproval/Rejected/Active/Archived all resolve).
   * Falls back to the "en" variant when the requested locale doesn't exist
   * for this templateId, rather than a hard 404 for a partially-translated template.
   */
  static async getTemplateById({ tenantId, templateId, locale = "en" }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");

    let template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale }).lean();
    if (!template && locale !== "en") {
      template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale: "en" }).lean();
    }
    if (!template) throw new Error(`Communication template ${templateId} not found.`);
    return template;
  }

  /**
   * The real approval gate every SEND path (CommunicationPlatformService,
   * EmailPlatformService, SmsPlatformService, WhatsAppPlatformService) must
   * call instead of getTemplateById() — refuses anything not "Active", so a
   * Draft/PendingApproval/Rejected template can never affect a live send no
   * matter what a caller passes as templateId.
   */
  static async getPublishedTemplateForSend({ tenantId, templateId, locale = "en" }) {
    const template = await this.getTemplateById({ tenantId, templateId, locale });
    if (template.status !== "Active") {
      throw new Error(`Template ${templateId} (${template.locale}) is "${template.status}", not Active — it must be approved before it can be used to send.`);
    }
    return template;
  }

  static async updateTemplate({ tenantId, templateId, locale = "en", updates = {}, userId = null }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");
    if (updates.status === "Active") {
      throw new Error(`A template cannot be set directly to "Active" — submit it for review (submitForReview) and approve it (approveTemplate) instead.`);
    }

    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale });
    if (!template) throw new Error(`Communication template ${templateId} (${locale}) not found.`);

    if (updates.name) template.name = updates.name;
    if (updates.subjectTemplate !== undefined) template.subjectTemplate = updates.subjectTemplate;
    if (updates.bodyTemplate) template.bodyTemplate = updates.bodyTemplate;
    if (updates.variables) template.variables = updates.variables;
    if (updates.status) template.status = updates.status;
    // Editing content on a Rejected template implicitly returns it to Draft
    // — it needs to go through submitForReview again, not stay "Rejected"
    // forever once fixed.
    if ((updates.subjectTemplate !== undefined || updates.bodyTemplate || updates.variables) && template.status === "Rejected" && !updates.status) {
      template.status = "Draft";
    }
    template.version += 1;

    await template.save();
    await this._snapshotVersion(template, userId);
    publishEvent("CommunicationTemplateUpdated", { tenantId, templateId: template.templateId, locale: template.locale });
    return template;
  }

  /**
   * Draft/Rejected -> PendingApproval. "Before a template affects live
   * sends" starts here — this is the only path into the approval queue.
   */
  static async submitForReview({ tenantId, templateId, locale = "en", userId = null }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");

    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale });
    if (!template) throw new Error(`Communication template ${templateId} (${locale}) not found.`);
    if (!["Draft", "Rejected"].includes(template.status)) {
      throw new Error(`Template ${templateId} (${locale}) is "${template.status}" — only Draft or Rejected templates can be submitted for review.`);
    }

    template.status = "PendingApproval";
    template.submittedBy = userId;
    template.submittedAt = new Date();
    await template.save();

    publishEvent("CommunicationTemplateSubmitted", { tenantId, templateId, locale: template.locale, submittedBy: userId });
    return template;
  }

  /**
   * PendingApproval -> Active. The ONLY method that may set a template
   * live — permission-gating this call (e.g. `communication.template.approve`)
   * is the caller/controller's responsibility.
   */
  static async approveTemplate({ tenantId, templateId, locale = "en", userId = null }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");

    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale });
    if (!template) throw new Error(`Communication template ${templateId} (${locale}) not found.`);
    if (template.status !== "PendingApproval") {
      throw new Error(`Template ${templateId} (${locale}) is "${template.status}" — only a PendingApproval template can be approved.`);
    }

    template.status = "Active";
    template.approvedBy = userId;
    template.approvedAt = new Date();
    template.rejectedBy = null;
    template.rejectionReason = null;
    await template.save();

    publishEvent("CommunicationTemplateApproved", { tenantId, templateId, locale: template.locale, approvedBy: userId });
    return template;
  }

  /** PendingApproval -> Rejected, with a required reason — kicked back for edits, never silently discarded. */
  static async rejectTemplate({ tenantId, templateId, locale = "en", userId = null, reason }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");
    if (!reason) throw new Error("reason is required to reject a template.");

    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale });
    if (!template) throw new Error(`Communication template ${templateId} (${locale}) not found.`);
    if (template.status !== "PendingApproval") {
      throw new Error(`Template ${templateId} (${locale}) is "${template.status}" — only a PendingApproval template can be rejected.`);
    }

    template.status = "Rejected";
    template.rejectedBy = userId;
    template.rejectionReason = reason;
    await template.save();

    publishEvent("CommunicationTemplateRejected", { tenantId, templateId, locale: template.locale, rejectedBy: userId, reason });
    return template;
  }

  /**
   * List the full, immutable version history of a template locale variant (newest first).
   */
  static async listTemplateVersions({ tenantId, templateId, locale = "en" }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");
    return CommunicationTemplateVersionModel.find({ tenantId, templateId, locale }).sort({ version: -1 }).lean();
  }

  /**
   * Roll a template locale variant back to a prior version's content. This does not
   * delete or rewrite history — it applies the target version's content as a brand-new
   * version on top, so the rollback itself is also recorded and reversible. A rollback
   * to Active content still requires the template's own status to already be Active —
   * this restores CONTENT, it is not a second way to bypass the approval gate.
   */
  static async rollbackTemplate({ tenantId, templateId, locale = "en", toVersion, userId = null }) {
    if (!tenantId || !templateId) throw new Error("tenantId and templateId are required.");
    if (!toVersion) throw new Error("toVersion is required.");

    const template = await CommunicationTemplateModel.findOne({ tenantId, templateId, locale });
    if (!template) throw new Error(`Communication template ${templateId} (${locale}) not found.`);

    const targetVersion = await CommunicationTemplateVersionModel.findOne({ tenantId, templateId, locale, version: toVersion }).lean();
    if (!targetVersion) throw new Error(`Version ${toVersion} not found for template ${templateId} (${locale}).`);

    template.name = targetVersion.name;
    template.subjectTemplate = targetVersion.subjectTemplate;
    template.bodyTemplate = targetVersion.bodyTemplate;
    template.variables = targetVersion.variables;
    // Content rolls back; approval status does not silently follow it — a
    // template already Active stays Active (content-only revert), and one
    // still under review/rejected keeps its own real status untouched.
    template.version += 1;

    await template.save();
    await this._snapshotVersion(template, userId);

    publishEvent("TemplateRolledBack", {
      tenantId,
      templateId,
      locale: template.locale,
      rolledBackToVersion: toVersion,
      newVersion: template.version
    });

    return template;
  }

  /**
   * Internal: write an immutable snapshot of the template's current state to history.
   */
  static async _snapshotVersion(template, userId = null) {
    try {
      await CommunicationTemplateVersionModel.create({
        tenantId: template.tenantId,
        templateId: template.templateId,
        locale: template.locale,
        version: template.version,
        name: template.name,
        channel: template.channel,
        subjectTemplate: template.subjectTemplate,
        bodyTemplate: template.bodyTemplate,
        variables: template.variables,
        status: template.status,
        createdBy: userId ?? template.createdBy ?? null
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
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
