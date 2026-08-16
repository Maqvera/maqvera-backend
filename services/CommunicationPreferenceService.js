import CommunicationPreferenceModel from "../models/CommunicationPreferenceModel.js";

/**
 * Enterprise Communication Platform — Preference Engine Service
 * Manages user messaging preferences, DND rules, and channel opt-ins.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class CommunicationPreferenceService {
  static async getUserPreferences({ tenantId, userId }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");

    let pref = await CommunicationPreferenceModel.findOne({ tenantId, userId }).lean();
    if (!pref) {
      // Default preferences if not explicit
      pref = {
        tenantId,
        userId,
        emailOptIn: true,
        smsOptIn: true,
        whatsAppOptIn: true,
        pushOptIn: true,
        inAppOptIn: true,
        preferredChannel: "Email",
        doNotDisturb: false
      };
    }
    return pref;
  }

  static async updateUserPreferences({ tenantId, userId, preferences = {} }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");

    const pref = await CommunicationPreferenceModel.findOneAndUpdate(
      { tenantId, userId },
      {
        $set: {
          tenantId,
          userId,
          ...preferences
        }
      },
      { upsert: true, new: true, runValidators: true }
    );

    return pref;
  }

  static async canSendToUser({ tenantId, userId, channel }) {
    if (!userId) return { allowed: true, reason: "No userId specified" };

    const pref = await this.getUserPreferences({ tenantId, userId });

    if (pref.doNotDisturb) {
      return { allowed: false, reason: "User has enabled Do Not Disturb (DND)." };
    }

    const channelOptInMap = {
      Email: pref.emailOptIn,
      SMS: pref.smsOptIn,
      WhatsApp: pref.whatsAppOptIn,
      Push: pref.pushOptIn,
      InApp: pref.inAppOptIn,
      Webhook: true
    };

    const isOptedIn = channelOptInMap[channel] ?? true;
    if (!isOptedIn) {
      return { allowed: false, reason: `User has opted out of ${channel} communications.` };
    }

    return { allowed: true, reason: "Opted in" };
  }
}

export default CommunicationPreferenceService;
