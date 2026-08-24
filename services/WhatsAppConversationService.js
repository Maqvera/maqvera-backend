import WhatsAppConversationModel from "../models/WhatsAppConversationModel.js";
import { getWhatsAppConfig } from "../utils/whatsAppConfig.js";

/**
 * Enterprise WhatsApp Platform — Conversation Window Engine (Part 4).
 * The single, shared enforcement point for Meta's WhatsApp Business
 * 24-hour customer-service-window policy. Every WhatsApp send path in this
 * codebase (WhatsAppPlatformService, CommunicationPlatformService's generic
 * "WhatsApp" channel) MUST call `assertCanSendFreeform` before dispatching a
 * free-form (non-templated) message — never re-implemented per call site.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class WhatsAppConversationService {
  /** Real record of the conversation window for (tenantId, phone), or null if the customer has never messaged in. */
  static async getConversationWindow({ tenantId, phone }) {
    if (!tenantId || !phone) throw new Error("tenantId and phone are required.");
    return WhatsAppConversationModel.findOne({ tenantId, phone }).lean();
  }

  static async isWindowOpen({ tenantId, phone }) {
    const conversation = await this.getConversationWindow({ tenantId, phone });
    if (!conversation?.windowExpiresAt) return false;
    return new Date(conversation.windowExpiresAt).getTime() > Date.now();
  }

  /**
   * Called on receipt of an inbound WhatsApp message from the customer —
   * opens/refreshes the 24-hour window. No inbound webhook receiver exists
   * in this codebase yet (a real one needs provider-specific signature
   * verification and is genuine follow-up work), but this is the single
   * place that receiver will call into once built — the enforcement below
   * is real today even though nothing currently opens a window.
   */
  static async recordInboundMessage({ tenantId, phone }) {
    if (!tenantId || !phone) throw new Error("tenantId and phone are required.");
    const config = getWhatsAppConfig();
    const now = new Date();
    const windowExpiresAt = new Date(now.getTime() + config.conversationWindowHours * 60 * 60 * 1000);

    return WhatsAppConversationModel.findOneAndUpdate(
      { tenantId, phone },
      { $set: { tenantId, phone, lastInboundAt: now, windowExpiresAt } },
      { upsert: true, new: true }
    );
  }

  /** Called after a successful outbound send — records activity but, per Meta's rule, does NOT extend the window (only inbound does). */
  static async recordOutboundMessage({ tenantId, phone }) {
    if (!tenantId || !phone) throw new Error("tenantId and phone are required.");
    return WhatsAppConversationModel.findOneAndUpdate(
      { tenantId, phone },
      { $set: { tenantId, phone, lastOutboundAt: new Date() } },
      { upsert: true, new: true }
    );
  }

  /**
   * The real compliance gate. Throws when a free-form (non-templated) send
   * would violate Meta's policy — no open conversation window. Callers
   * sending a templateId-backed message should NOT call this (an approved
   * template is exactly what the policy allows outside the window).
   */
  static async assertCanSendFreeform({ tenantId, phone }) {
    const open = await this.isWindowOpen({ tenantId, phone });
    if (!open) {
      throw new Error(
        `An approved WhatsApp template is required to message ${phone}: no open 24-hour customer conversation window ` +
        `(Meta's WhatsApp Business policy prohibits free-form business-initiated messages outside this window).`
      );
    }
  }
}

export default WhatsAppConversationService;
