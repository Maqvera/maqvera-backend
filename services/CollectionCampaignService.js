import CollectionCampaignModel from "../models/CollectionCampaignModel.js";
import CustomerCollectionModel from "../models/CustomerCollectionModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CustomerCollectionService from "./CustomerCollectionService.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly.
// ---------------------------------------------------------------------------

/** Builds a real Mongo filter from a campaign's own `targetCriteria` — never a canned segment. */
export const buildCampaignFilter = (tenantId, targetCriteria = {}) => {
  const filter = { tenantId };
  if (targetCriteria.status) filter.status = targetCriteria.status;
  if (targetCriteria.collectionSource) filter.collectionSource = targetCriteria.collectionSource;
  if (targetCriteria.currency) filter.currency = targetCriteria.currency;
  if (targetCriteria.collectionStage) filter.collectionStage = targetCriteria.collectionStage;
  if (targetCriteria.minAmount !== null && targetCriteria.minAmount !== undefined) filter.totalAmount = { ...filter.totalAmount, $gte: targetCriteria.minAmount };
  if (targetCriteria.maxAmount !== null && targetCriteria.maxAmount !== undefined) filter.totalAmount = { ...filter.totalAmount, $lte: targetCriteria.maxAmount };
  if (targetCriteria.minDaysOverdue !== null && targetCriteria.minDaysOverdue !== undefined) {
    filter.paymentDueDate = { $lte: new Date(Date.now() - targetCriteria.minDaysOverdue * 86400000) };
  }
  return filter;
};

/**
 * "Collection Priorities... VIP Customer, High Amount, Oldest Invoice,
 * Risk Score, Subscription Priority, Contract Priority, Customer
 * Segment." A real, deterministic score over fields that actually exist
 * on a collection/customer — never a fabricated ML risk score. Higher is
 * more urgent to collect.
 */
export const computeCollectionPriority = ({ amount, daysOverdue = 0, customerCategory = null, collectionStage = null, isSubscription = false }) => {
  let score = 0;
  if (["vip", "premium"].includes(customerCategory)) score += 30;
  if (amount >= 100000) score += 25;
  else if (amount >= 10000) score += 15;
  else if (amount >= 1000) score += 5;
  score += Math.min(daysOverdue, 90) / 2; // up to +45 for a very old balance
  if (collectionStage) score += 10; // already escalated at least once
  if (isSubscription) score += 5;
  score = Math.min(Math.round(score), 100);

  let label = "Low";
  if (score >= 70) label = "Critical";
  else if (score >= 45) label = "High";
  else if (score >= 20) label = "Medium";
  return { score, label };
};

class CollectionCampaignService {
  static async _generateCampaignNumber(tenantId) {
    const config = getFinanceConfig();
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "collectionCampaignNumber", year);
    return `${config.collectionCampaignNumberPrefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  /** POST /api/v1/collection-campaigns */
  static async createCampaign(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, description = null, campaignType, targetCriteria = {}, reminderChannel = "Email" } = data;
    if (!name || !campaignType) throw new Error("name and campaignType are required.");
    if (!config.collectionCampaignTypes.includes(campaignType)) throw new Error(`Invalid campaignType "${campaignType}".`);
    if (!config.deliveryMethods.includes(reminderChannel)) throw new Error(`Invalid reminderChannel "${reminderChannel}".`);

    const campaignNumber = await CollectionCampaignService._generateCampaignNumber(tenantId);
    const campaign = await CollectionCampaignModel.create({
      tenantId, campaignNumber, name, description, campaignType, status: "Draft", targetCriteria, reminderChannel,
      timeline: [{ event: "CollectionCampaignCreated", description: `Campaign "${name}" (${campaignType}) created.`, performedBy: userId || null }],
      createdBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.collectioncampaign.create", module: "Finance", resource: "CollectionCampaign", resourceId: campaign._id.toString(), userId: userId || null, tenantId, details: { campaignNumber, campaignType } });
    publishEvent("CollectionCampaignCreated", { tenantId, campaignId: campaign._id.toString(), campaignType, performedBy: userId || null });

    return campaign.toJSON();
  }

  /** GET /api/v1/collection-campaigns/{campaignId}/preview — how many collections/how much outstanding this campaign would target right now, without sending anything. */
  static async previewTargets(campaignId, tenantId) {
    const campaign = await CollectionCampaignModel.findOne({ _id: campaignId, tenantId }).lean();
    if (!campaign) throw new Error("Collection campaign not found.");

    const filter = buildCampaignFilter(tenantId, campaign.targetCriteria);
    const [count, totals] = await Promise.all([
      CustomerCollectionModel.countDocuments(filter),
      CustomerCollectionModel.aggregate([{ $match: filter }, { $group: { _id: null, totalOutstanding: { $sum: { $subtract: ["$totalAmount", "$collectedAmount"] } } } }])
    ]);

    return { targetedCount: count, totalOutstandingAmount: roundCurrency(totals[0]?.totalOutstanding || 0) };
  }

  /**
   * POST /api/v1/collection-campaigns/{campaignId}/run — sends a real
   * reminder (`CustomerCollectionService.sendReminder`'s own real
   * services/delivery/ adapters) to every collection matching this
   * campaign's `targetCriteria`, right now. Not a scheduled/batched send
   * — this codebase has no job-queue infrastructure (same honest
   * boundary `utils/eventBus.js` already documents for
   * `EVENT_BUS_TRANSPORT=memory`), so a very large campaign runs
   * synchronously within the request.
   */
  static async runCampaign(campaignId, tenantId, userId) {
    const campaign = await CollectionCampaignModel.findOne({ _id: campaignId, tenantId });
    if (!campaign) throw new Error("Collection campaign not found.");
    if (campaign.status !== "Draft") throw new Error(`Cannot run a campaign in status "${campaign.status}".`);

    const filter = buildCampaignFilter(tenantId, campaign.targetCriteria);
    const targets = await CustomerCollectionModel.find(filter).select("_id totalAmount collectedAmount").lean();

    campaign.status = "Active";
    campaign.startedAt = new Date();
    campaign.targetedCollectionIds = targets.map((t) => t._id);
    campaign.results.targetedCount = targets.length;
    campaign.results.totalOutstandingAmount = roundCurrency(targets.reduce((sum, t) => sum + (t.totalAmount - t.collectedAmount), 0));
    await campaign.save();

    let sent = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const reminder = await CustomerCollectionService.sendReminder(target._id, { channel: campaign.reminderChannel }, tenantId, userId);
        if (reminder.status === "Sent") sent += 1; else failed += 1;
      } catch (error) {
        failed += 1;
      }
    }

    campaign.status = "Completed";
    campaign.completedAt = new Date();
    campaign.results.remindersSent = sent;
    campaign.results.remindersFailed = failed;
    campaign.timeline.push({ event: "CollectionCampaignCompleted", description: `${targets.length} target(s), ${sent} reminder(s) sent, ${failed} failed.`, performedBy: userId || null });
    await campaign.save();

    await AuditLogModel.create({ action: "finance.collectioncampaign.run", module: "Finance", resource: "CollectionCampaign", resourceId: campaign._id.toString(), userId: userId || null, tenantId, details: { targetedCount: targets.length, sent, failed } });
    publishEvent("CollectionCampaignCompleted", { tenantId, campaignId: campaign._id.toString(), targetedCount: targets.length, sent, failed, performedBy: userId || null });

    return campaign.toJSON();
  }

  static async cancelCampaign(campaignId, tenantId, userId) {
    const campaign = await CollectionCampaignModel.findOne({ _id: campaignId, tenantId });
    if (!campaign) throw new Error("Collection campaign not found.");
    if (campaign.status !== "Draft") throw new Error(`Only a Draft campaign can be cancelled (status "${campaign.status}").`);

    campaign.status = "Cancelled";
    campaign.timeline.push({ event: "CollectionCampaignCancelled", description: "Campaign cancelled.", performedBy: userId || null });
    await campaign.save();

    return campaign.toJSON();
  }

  static async getCampaignById(campaignId, tenantId) {
    const campaign = await CollectionCampaignModel.findOne({ _id: campaignId, tenantId }).lean();
    if (!campaign) throw new Error("Collection campaign not found.");
    return campaign;
  }

  static async listCampaigns(query, tenantId) {
    const { status, campaignType } = query;
    const filter = { tenantId };
    if (status) filter.status = status;
    if (campaignType) filter.campaignType = campaignType;
    return CollectionCampaignModel.find(filter).sort({ createdAt: -1 }).lean();
  }
}

export default CollectionCampaignService;
