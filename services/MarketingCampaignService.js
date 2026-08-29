import MarketingCampaignModel from "../models/MarketingCampaignModel.js";
import MarketingCampaignRecipientModel from "../models/MarketingCampaignRecipientModel.js";
import CustomerModel from "../models/CustomerModel.js";
import CountryMasterModel from "../models/CountryMasterModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CommunicationTemplateService from "./CommunicationTemplateService.js";
import EmailPlatformService from "./EmailPlatformService.js";
import SmsPlatformService from "./SmsPlatformService.js";
import WhatsAppPlatformService from "./WhatsAppPlatformService.js";
import { publishEvent } from "../utils/eventBus.js";

// Marketing Campaign System — PRD "CRM Feature Map by Phase" Phase 2 module
// 20 (part). This service is deliberately an orchestration layer only:
// segment resolution reuses CustomerController.ListCustomers' own filter
// shape (utils below mirror it, never a client-supplied raw Mongo query),
// and the actual fan-out send reuses EmailPlatformService/SmsPlatformService/
// WhatsAppPlatformService directly — no parallel sending/provider logic is
// introduced here. Distinct from services/CollectionCampaignController's
// campaign concept (finance/debt-collection, unrelated domain) and from
// SmsPlatformService's own createBulkCampaign (SMS-only, a narrower
// existing tool) — this is the cross-channel (Email/SMS/WhatsApp) segment
// campaign the PRD actually asks for.
const CHANNEL_CONTACT_FIELD = { Email: "email", SMS: "phone", WhatsApp: "phone" };

// Same filter shape as controllers/CustomerController.js's ListCustomers —
// intentionally a subset (customerType/category/status/cityId/countryId/
// createdAfter/createdBefore), not a client-supplied raw Mongo query.
async function buildSegmentFilter(tenantId, segmentFilter = {}) {
  const filter = { tenantId, status: { $ne: "archived" } };
  if (segmentFilter.customerType) filter.type = segmentFilter.customerType.toLowerCase();
  if (segmentFilter.category) filter.category = segmentFilter.category.toLowerCase();
  if (segmentFilter.status) filter.status = segmentFilter.status.toLowerCase();
  if (segmentFilter.assignedTo) filter.assignedTo = segmentFilter.assignedTo;
  if (segmentFilter.countryId) {
    const country = await CountryMasterModel.findOne({ tenantId, countryId: segmentFilter.countryId, isActive: true }).lean();
    filter["address.country"] = country ? country.name : segmentFilter.countryId;
  }
  if (segmentFilter.cityId) filter["address.city"] = new RegExp(`^${segmentFilter.cityId}$`, "i");
  if (segmentFilter.createdAfter || segmentFilter.createdBefore) {
    filter.createdAt = {};
    if (segmentFilter.createdAfter) filter.createdAt.$gte = new Date(segmentFilter.createdAfter);
    if (segmentFilter.createdBefore) filter.createdAt.$lte = new Date(segmentFilter.createdBefore);
  }
  return filter;
}

class MarketingCampaignService {
  static async createCampaign(data, tenantId, userId) {
    const { name, channel, templateId, segmentFilter = {}, scheduledAt = null } = data;
    if (!name) throw new Error("name is required.");
    if (!["Email", "SMS", "WhatsApp"].includes(channel)) throw new Error(`Invalid channel "${channel}". Allowed: Email, SMS, WhatsApp.`);
    if (!templateId) throw new Error("templateId is required.");

    const template = await CommunicationTemplateService.getPublishedTemplateForSend({ tenantId, templateId });
    if (template.channel !== channel) throw new Error(`Template "${templateId}" is a ${template.channel} template — cannot be used for a ${channel} campaign. Pick a template on the same channel.`);

    const filter = await buildSegmentFilter(tenantId, segmentFilter);
    const contactField = CHANNEL_CONTACT_FIELD[channel];
    filter[contactField] = { $exists: true, $nin: [null, ""] };
    const customers = await CustomerModel.find(filter).select("_id").lean();

    const campaign = await MarketingCampaignModel.create({
      tenantId, name, channel, templateId, segmentFilter,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      status: scheduledAt ? "scheduled" : "draft",
      recipientCount: customers.length,
      createdBy: userId || null, updatedBy: userId || null
    });

    if (customers.length > 0) {
      await MarketingCampaignRecipientModel.insertMany(
        customers.map((c) => ({ tenantId, campaignId: campaign._id, customerId: c._id, status: "pending" })),
        { ordered: false }
      );
    }

    await AuditLogModel.create({ action: "campaign.create", module: "MarketingCampaign", resource: "MarketingCampaign", resourceId: campaign._id.toString(), userId: userId || null, tenantId, details: { channel, recipientCount: customers.length } });
    publishEvent("CampaignCreated", { tenantId, campaignId: campaign._id.toString(), channel, recipientCount: customers.length, performedBy: userId || null });

    return campaign.toJSON();
  }

  static async listCampaigns(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.channel) filter.channel = query.channel;
    return MarketingCampaignModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getCampaignById(campaignId, tenantId) {
    const campaign = await MarketingCampaignModel.findOne({ _id: campaignId, tenantId }).lean();
    if (!campaign) throw new Error("Campaign not found.");
    return campaign;
  }

  /**
   * POST /campaigns/:id/send — fans out to every `pending` recipient via
   * the real platform service for the campaign's channel. Never a new
   * send/provider path: each call is exactly the same
   * EmailPlatformService.sendEmail/SmsPlatformService.sendSms/
   * WhatsAppPlatformService.sendWhatsApp any other module in this codebase
   * already calls, with sourceModule: "MarketingCampaign" so a delivered/
   * failed event still flows through the existing communication event bus.
   * A per-recipient failure is recorded on that recipient's own row and
   * never aborts the rest of the fan-out — one bad phone number/email must
   * never block the whole campaign.
   */
  static async sendCampaign(campaignId, tenantId, userId) {
    const campaign = await MarketingCampaignModel.findOne({ _id: campaignId, tenantId });
    if (!campaign) throw new Error("Campaign not found.");
    if (!["draft", "scheduled"].includes(campaign.status)) throw new Error(`Campaign cannot be sent from status "${campaign.status}".`);

    campaign.status = "sending";
    await campaign.save();

    const recipients = await MarketingCampaignRecipientModel.find({ tenantId, campaignId: campaign._id, status: "pending" });
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      try {
        const customer = await CustomerModel.findOne({ _id: recipient.customerId, tenantId }).select("firstName lastName email phone preferredLanguage").lean();
        if (!customer) throw new Error("Customer no longer exists.");

        const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
        // Multi-Language System (PRD "CRM Feature Map by Phase" Phase 3
        // module 37) — selects the recipient's own EN/UR/AR
        // CommunicationTemplateModel locale variant when one exists;
        // CommunicationTemplateService.getPublishedTemplateForSend already
        // falls back to "en" if that specific locale isn't published.
        const locale = customer.preferredLanguage || "en";
        let result;
        if (campaign.channel === "Email") {
          if (!customer.email) throw new Error("Customer has no email on file.");
          result = await EmailPlatformService.sendEmail({ tenantId, templateId: campaign.templateId, to: customer.email, variables: { customerName: fullName, campaignId: campaign._id.toString() }, locale, sourceModule: "MarketingCampaign", emailType: "Marketing", userId });
        } else if (campaign.channel === "SMS") {
          if (!customer.phone) throw new Error("Customer has no phone on file.");
          result = await SmsPlatformService.sendSms({ tenantId, phone: customer.phone, templateId: campaign.templateId, variables: { customerName: fullName, campaignId: campaign._id.toString() }, locale, sourceModule: "MarketingCampaign", userId });
        } else {
          if (!customer.phone) throw new Error("Customer has no phone on file.");
          result = await WhatsAppPlatformService.sendWhatsApp({ tenantId, phone: customer.phone, templateId: campaign.templateId, templateData: { customerName: fullName, campaignId: campaign._id.toString() }, locale, sourceModule: "MarketingCampaign", userId });
        }

        recipient.status = "sent";
        recipient.trackingId = result?.trackingId || null;
        recipient.sentAt = new Date();
        await recipient.save();
        sentCount += 1;
      } catch (error) {
        recipient.status = "failed";
        recipient.error = error.message;
        await recipient.save();
        failedCount += 1;
      }
    }

    campaign.status = "sent";
    campaign.sentCount = sentCount;
    campaign.failedCount = failedCount;
    campaign.sentAt = new Date();
    campaign.updatedBy = userId || null;
    await campaign.save();

    await AuditLogModel.create({ action: "campaign.send", module: "MarketingCampaign", resource: "MarketingCampaign", resourceId: campaign._id.toString(), userId: userId || null, tenantId, details: { sentCount, failedCount } });
    publishEvent("CampaignSent", { tenantId, campaignId: campaign._id.toString(), sentCount, failedCount, performedBy: userId || null });

    return campaign.toJSON();
  }

  static async getCampaignAnalytics(campaignId, tenantId) {
    const campaign = await MarketingCampaignModel.findOne({ _id: campaignId, tenantId }).lean();
    if (!campaign) throw new Error("Campaign not found.");

    const rows = await MarketingCampaignRecipientModel.aggregate([
      { $match: { tenantId, campaignId: campaign._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);
    const byStatus = { pending: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 };
    for (const row of rows) byStatus[row._id] = row.count;

    return {
      campaignId: campaign._id.toString(),
      status: campaign.status,
      recipientCount: campaign.recipientCount,
      byStatus
    };
  }
}

export default MarketingCampaignService;
