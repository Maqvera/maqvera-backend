import AgentModel from "../models/AgentModel.js";
import AgentWalletTransactionModel from "../models/AgentWalletTransactionModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CommissionRuleModel from "../models/CommissionRuleModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import AgentService from "./AgentService.js";
import { computeMarkupAmount } from "./PackagePricingService.js";
import { subscribeEvent, publishEvent } from "../utils/eventBus.js";
import logger from "../utils/logger.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * B2B Agent Portal (PRD "CRM Feature Map by Phase" Phase 2 module 14) —
 * wires CommissionRuleModel (previously a stored rule that only fed
 * `commissionPerPerson` into the package pricing PREVIEW, never actually
 * paid anyone) into a real AgentWalletModel credit once a booking sold
 * through an agent is genuinely created. Fires off `BookingCreated`
 * (controllers/BookingController.js), the same real domain event every
 * other "something happened to a booking" side effect in this codebase
 * subscribes to, rather than being called inline from booking creation.
 *
 * Deliberately scoped to Agent- and Global-scope commission rules only —
 * Destination/Hotel-scoped rules need segment data (country/hotel per leg)
 * that BookingHeaderModel doesn't carry post-conversion; those already
 * factor into the package pricing engine's own `commissionPerPerson`
 * preview at quote time (services/PackagePricingService.js), just not into
 * this real wallet-crediting event. A real, honest scope boundary, not a
 * silent gap.
 */
class AgentCommissionService {
  static _initialized = false;

  static initEventListeners() {
    if (this._initialized) return;
    this._initialized = true;

    subscribeEvent("BookingCreated", ({ bookingId, tenantId }) => {
      if (!bookingId || !tenantId) return;
      queueMicrotask(() =>
        AgentCommissionService.creditCommissionForBooking(bookingId, tenantId)
          .catch((error) => logger.error("Agent commission crediting failed.", { bookingId, tenantId, error: error.message }))
      );
    });
  }

  static async creditCommissionForBooking(bookingId, tenantId) {
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking || !booking.agentUserId) return null;

    const agent = await AgentModel.findOne({ _id: booking.agentUserId, tenantId }).lean();
    // Honest no-op — the agent record may have been removed/suspended
    // between booking creation and this async credit; never fabricate a
    // credit to a wallet that no longer has a live owner.
    if (!agent || agent.status !== "Active") return null;

    const rules = await CommissionRuleModel.find({ tenantId, active: true, scope: { $in: ["Agent", "Global"] } }).lean();
    const applicable = rules.filter((rule) => rule.scope === "Global" || (rule.scope === "Agent" && rule.agentUserId === booking.agentUserId));
    if (applicable.length === 0) return null;

    const totalCommission = roundCurrency(applicable.reduce((sum, rule) => sum + computeMarkupAmount(booking.totalAmount, rule.type, rule.value), 0));
    if (totalCommission <= 0) return null;

    const wallet = await AgentService.getOrCreateWallet(booking.agentUserId, agent.name, booking.currency, tenantId, "system");
    wallet.balance = roundCurrency(wallet.balance + totalCommission);
    wallet.updatedBy = "system";
    await wallet.save();

    const transaction = await AgentWalletTransactionModel.create({
      tenantId, walletId: wallet._id, type: "CommissionEarned", direction: "Credit", amount: totalCommission, balanceAfter: wallet.balance,
      currency: wallet.currency, bookingId: booking._id, commissionRuleId: applicable[0]._id,
      description: `Commission for booking ${booking.bookingReference}${applicable.length > 1 ? ` (${applicable.length} rules stacked)` : ""}`,
      performedBy: "system"
    });

    await AuditLogModel.create({
      action: "agent.wallet.commission_credited", module: "Agent", resource: "AgentWallet", resourceId: wallet._id.toString(),
      userId: null, tenantId, details: { bookingId: booking._id.toString(), amount: totalCommission, ruleCount: applicable.length }
    });
    publishEvent("AgentCommissionCredited", { tenantId, agentId: booking.agentUserId, bookingId: booking._id.toString(), amount: totalCommission, currency: wallet.currency });

    return transaction.toJSON();
  }
}

export default AgentCommissionService;
