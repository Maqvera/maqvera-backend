import CommunicationPreferenceModel from "../models/CommunicationPreferenceModel.js";
import CommunicationConsentHistoryModel from "../models/CommunicationConsentHistoryModel.js";

const TRACKED_PREFERENCE_FIELDS = [
  "emailOptIn",
  "smsOptIn",
  "whatsAppOptIn",
  "pushOptIn",
  "inAppOptIn",
  "preferredChannel",
  "doNotDisturb",
  "quietHours",
  "subscribedTopics",
  "unsubscribedTopics"
];

const DEFAULT_PREFERENCES = {
  emailOptIn: true,
  smsOptIn: true,
  whatsAppOptIn: true,
  pushOptIn: true,
  inAppOptIn: true,
  preferredChannel: "Email",
  doNotDisturb: false,
  quietHours: { start: null, end: null, timezone: "UTC" },
  subscribedTopics: [],
  unsubscribedTopics: []
};

/**
 * Enterprise Communication Platform — Preference Engine Service
 * Manages user messaging preferences, DND rules, quiet hours, topic-level opt-outs, and
 * channel opt-ins. Every change is snapshotted to CommunicationConsentHistoryModel — the
 * live document previously was overwritten via findOneAndUpdate with no history, which
 * made "when did this user withdraw consent" unanswerable (GDPR/CCPA-relevant).
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
        ...DEFAULT_PREFERENCES
      };
    }
    return pref;
  }

  static async updateUserPreferences({ tenantId, userId, preferences = {}, actorUserId = null }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");

    const before = await this.getUserPreferences({ tenantId, userId });

    const changes = TRACKED_PREFERENCE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(preferences, field))
      .map((field) => ({ field, oldValue: before[field] ?? null, newValue: preferences[field] }))
      .filter((change) => JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue));

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

    if (changes.length > 0) {
      await this._logConsentHistory({ tenantId, userId, changes, actorUserId: actorUserId ?? userId });
    }

    return pref;
  }

  static async canSendToUser({ tenantId, userId, channel, priority = "Normal", topic = null }) {
    if (!userId) return { allowed: true, reason: "No userId specified" };

    const pref = await this.getUserPreferences({ tenantId, userId });
    const isCritical = priority === "Critical";

    if (pref.doNotDisturb && !isCritical) {
      return { allowed: false, reason: "User has enabled Do Not Disturb (DND)." };
    }

    if (!isCritical && this._isWithinQuietHours(pref.quietHours)) {
      return { allowed: false, reason: "Send blocked by user's quiet hours." };
    }

    if (topic && Array.isArray(pref.unsubscribedTopics) && pref.unsubscribedTopics.includes(topic) && !isCritical) {
      return { allowed: false, reason: `User has opted out of the "${topic}" topic.` };
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
    if (!isOptedIn && !isCritical) {
      return { allowed: false, reason: `User has opted out of ${channel} communications.` };
    }

    return { allowed: true, reason: "Opted in" };
  }

  /**
   * Full, immutable consent/preference change history for a user (newest first).
   */
  static async getConsentHistory({ tenantId, userId, page = 1, limit = 20 }) {
    if (!tenantId || !userId) throw new Error("tenantId and userId are required.");
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      CommunicationConsentHistoryModel.find({ tenantId, userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunicationConsentHistoryModel.countDocuments({ tenantId, userId })
    ]);
    return { data, total, page: Number(page), limit: Number(limit) };
  }

  /**
   * Whether "now" (in the preference's own timezone) falls inside the user's quiet-hours
   * window. A window may wrap midnight (e.g. 22:00 -> 07:00).
   */
  static _isWithinQuietHours(quietHours) {
    if (!quietHours || !quietHours.start || !quietHours.end) return false;

    const toMinutes = (hhmm) => {
      const [h, m] = String(hhmm).split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    };

    const startMinutes = toMinutes(quietHours.start);
    const endMinutes = toMinutes(quietHours.end);
    if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return false;

    let nowMinutes;
    try {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: quietHours.timezone || "UTC"
      });
      const parts = formatter.formatToParts(new Date());
      const hh = Number(parts.find((p) => p.type === "hour")?.value);
      const mm = Number(parts.find((p) => p.type === "minute")?.value);
      nowMinutes = hh * 60 + mm;
    } catch {
      const now = new Date();
      nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    }

    if (startMinutes < endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Window wraps midnight (e.g. 22:00 -> 07:00)
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  static async _logConsentHistory({ tenantId, userId, changes, actorUserId = null }) {
    try {
      await CommunicationConsentHistoryModel.create({
        tenantId,
        userId,
        changes,
        actorUserId
      });
    } catch (err) {
      console.error("Communication consent history log failure:", err);
    }
  }
}

export default CommunicationPreferenceService;
