import LeadModel from "../models/LeadModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { CreateCustomer } from "../controllers/CustomerController.js";
import { getLeadConfig } from "../utils/leadConfig.js";
import { publishEvent } from "../utils/eventBus.js";

class LeadService {
  static async createLead(data, tenantId, userId) {
    const config = getLeadConfig();
    const { firstName, lastName = null, email = null, phone = null, source, status, assignedToUserId = null, followUpDate = null, interestedInPackageId = null, notes = null, tags = [] } = data;
    if (!firstName) throw new Error("firstName is required.");

    const resolvedSource = source || config.defaultLeadSource;
    if (!config.leadSources.includes(resolvedSource)) throw new Error(`Invalid source "${resolvedSource}". Allowed: ${config.leadSources.join(", ")}.`);
    const resolvedStatus = status || config.defaultLeadStatus;
    if (!config.leadStatuses.includes(resolvedStatus)) throw new Error(`Invalid status "${resolvedStatus}". Allowed: ${config.leadStatuses.join(", ")}.`);

    const lead = await LeadModel.create({
      tenantId, firstName, lastName, email, phone, source: resolvedSource, status: resolvedStatus,
      assignedToUserId, followUpDate: followUpDate ? new Date(followUpDate) : null, interestedInPackageId, notes,
      tags: Array.isArray(tags) ? tags : [], createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "lead.create", module: "Lead", resource: "Lead", resourceId: lead._id.toString(), userId: userId || null, tenantId, details: { source: resolvedSource } });
    publishEvent("LeadCreated", { tenantId, leadId: lead._id.toString(), source: resolvedSource, performedBy: userId || null });

    return lead.toJSON();
  }

  static async listLeads(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.source) filter.source = query.source;
    if (query.assignedToUserId) filter.assignedToUserId = query.assignedToUserId;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 100);

    const [items, total] = await Promise.all([
      LeadModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      LeadModel.countDocuments(filter)
    ]);

    return { items, total, page, pageSize };
  }

  static async getLeadById(leadId, tenantId) {
    const lead = await LeadModel.findOne({ _id: leadId, tenantId }).lean();
    if (!lead) throw new Error("Lead not found.");
    return lead;
  }

  static async updateLead(leadId, data, tenantId, userId) {
    const config = getLeadConfig();
    const lead = await LeadModel.findOne({ _id: leadId, tenantId });
    if (!lead) throw new Error("Lead not found.");

    const { firstName, lastName, email, phone, source, status, assignedToUserId, followUpDate, interestedInPackageId, notes, tags } = data;
    if (source !== undefined && !config.leadSources.includes(source)) throw new Error(`Invalid source "${source}". Allowed: ${config.leadSources.join(", ")}.`);
    if (status !== undefined && !config.leadStatuses.includes(status)) throw new Error(`Invalid status "${status}". Allowed: ${config.leadStatuses.join(", ")}.`);

    if (firstName !== undefined) lead.firstName = firstName;
    if (lastName !== undefined) lead.lastName = lastName;
    if (email !== undefined) lead.email = email;
    if (phone !== undefined) lead.phone = phone;
    if (source !== undefined) lead.source = source;
    const statusChanged = status !== undefined && status !== lead.status;
    if (status !== undefined) lead.status = status;
    if (assignedToUserId !== undefined) lead.assignedToUserId = assignedToUserId;
    if (followUpDate !== undefined) {
      const newFollowUpDate = followUpDate ? new Date(followUpDate) : null;
      if (String(newFollowUpDate) !== String(lead.followUpDate)) lead.followUpReminderSentAt = null;
      lead.followUpDate = newFollowUpDate;
    }
    if (interestedInPackageId !== undefined) lead.interestedInPackageId = interestedInPackageId;
    if (notes !== undefined) lead.notes = notes;
    if (tags !== undefined) lead.tags = Array.isArray(tags) ? tags : [];
    lead.updatedBy = userId || null;

    await lead.save();

    await AuditLogModel.create({ action: "lead.update", module: "Lead", resource: "Lead", resourceId: lead._id.toString(), userId: userId || null, tenantId, details: { statusChanged, status: lead.status } });
    if (statusChanged) publishEvent("LeadStatusChanged", { tenantId, leadId: lead._id.toString(), status: lead.status, performedBy: userId || null });

    return lead.toJSON();
  }

  /**
   * POST /leads/:id/convert — creates a real CustomerModel row from the
   * lead by calling CustomerController.CreateCustomer directly (with a
   * synthetic req/res) rather than re-deriving its ~100 lines of
   * validation/duplicate-detection/customerCode-generation logic a second
   * time here. Same "don't duplicate creation logic" instruction this
   * feature was scoped under. `overrides` fills in whatever the lead itself
   * doesn't have (CustomerModel requires both email AND phone; a lead may
   * have neither yet).
   */
  static async convertToCustomer(leadId, overrides = {}, tenantId, userId, requestId) {
    const lead = await LeadModel.findOne({ _id: leadId, tenantId });
    if (!lead) throw new Error("Lead not found.");
    if (lead.convertedToCustomerId) throw new Error("This lead has already been converted.");

    const fakeReq = {
      auth: { tenantId, id: userId, userId, permissions: ["customer.create"] },
      requestId,
      body: {
        firstName: overrides.firstName || lead.firstName,
        lastName: overrides.lastName || lead.lastName,
        primaryEmail: overrides.email || lead.email,
        primaryPhone: overrides.phone || lead.phone,
        assignedTo: lead.assignedToUserId || userId || null,
        tags: lead.tags,
        notes: lead.notes,
        ...overrides.customerFields
      }
    };
    const fakeRes = {
      statusCode: null, body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };

    await CreateCustomer(fakeReq, fakeRes);
    if (!fakeRes.statusCode || fakeRes.statusCode >= 400) {
      throw new Error(fakeRes.body?.message || "Failed to create customer from lead.");
    }

    lead.status = "Converted";
    lead.convertedToCustomerId = fakeRes.body.data.customerId;
    lead.convertedAt = new Date();
    lead.updatedBy = userId || null;
    await lead.save();

    await AuditLogModel.create({ action: "lead.convert", module: "Lead", resource: "Lead", resourceId: lead._id.toString(), userId: userId || null, tenantId, details: { customerId: lead.convertedToCustomerId.toString() } });
    publishEvent("LeadConverted", { tenantId, leadId: lead._id.toString(), customerId: lead.convertedToCustomerId.toString(), performedBy: userId || null });

    return lead.toJSON();
  }

  /** GET /leads/pipeline — every configured status as its own bucket (even when empty), so the kanban view has a stable, predictable shape. */
  static async getPipeline(tenantId) {
    const config = getLeadConfig();
    const buckets = await LeadModel.aggregate([
      { $match: { tenantId } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$status", count: { $sum: 1 }, leads: { $push: { _id: "$_id", firstName: "$firstName", lastName: "$lastName", email: "$email", phone: "$phone", source: "$source", assignedToUserId: "$assignedToUserId", followUpDate: "$followUpDate", createdAt: "$createdAt" } } } }
    ]);
    const byStatus = new Map(buckets.map((b) => [b._id, b]));

    return config.leadStatuses.map((status) => ({
      status,
      count: byStatus.get(status)?.count || 0,
      // Kanban card list — capped so one enormous column can't blow up the payload.
      leads: (byStatus.get(status)?.leads || []).slice(0, 50)
    }));
  }
}

export default LeadService;
