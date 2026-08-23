import mongoose from "mongoose";
import { subscribeEvent } from "../utils/eventBus.js";
import getDeliveryAdapter from "./delivery/index.js";
import UserModel from "../models/UserModel.js";
import RoleModel from "../models/Rolemodel.js";
import NotificationLogModel from "../models/NotificationLogModel.js";
import { getAIObservabilityConfig } from "../utils/aiObservabilityConfig.js";

// Gap 1.1 "Notification delivery is a dead end" — `NotificationRequested`/
// `SecurityNotificationRequested`/`SupplierNotificationRequested` are
// published from 25+ call sites with NO real subscriber anywhere (the only
// existing one, CustomerCollectionService, explicitly ignores every payload
// except its own `ReceivableCollectionEscalated`). This is the single global
// choke point that actually delivers the rest, reusing the already-real
// services/delivery/ adapters (Email/WhatsApp/SMS/Webhook) — the same
// adapters CustomerCollectionService/ReceiptService already use — rather
// than inventing a second transport layer.
//
// Recipient-shape across those 25+ call sites is genuinely inconsistent
// (a raw `email`, a `recipientId` that means a User in some places and a
// raw contact string in others, `recipientIds` arrays, team/tier names with
// no resolvable target at all). Per this codebase's own "never silently
// guess a business rule" standard, this service only ever resolves a
// recipient through mechanisms that are either format-detectable (a string
// that IS an email/looks like one) or backed by a real, already-enforced
// concept (a User id, or the tenant's own RBAC permission grants) — anything
// else is honestly logged NotConfigured/Skipped, never fabricated.

const VALID_CHANNELS = ["Email", "WhatsApp", "SMS", "Webhook"];
const DEFAULT_CHANNEL = process.env.NOTIFICATION_DEFAULT_CHANNEL || "Email";

const isEmailish = (value) => typeof value === "string" && /^\S+@\S+\.\S+$/.test(value.trim());

const resolveChannel = (payload) => (VALID_CHANNELS.includes(payload?.channel) ? payload.channel : DEFAULT_CHANNEL);

/** Users belonging to any tenant role that holds the AI-observability manage permission (or "admin") — the real, already-enforced stand-in for "the tenant's configured admin/on-call recipient" this codebase has no dedicated concept for yet. */
const resolveTenantAdmins = async (tenantId) => {
  const config = getAIObservabilityConfig();
  const roles = await RoleModel.find({ tenantId, status: "active", permissions: { $in: [config.managePermission, "admin"] } }).select("name").lean();
  const roleNames = roles.map((r) => r.name);
  if (roleNames.length === 0) return [];
  const users = await UserModel.find({ tenantId, role: { $in: roleNames }, status: "active" }).select("email").lean();
  return users.filter((u) => isEmailish(u.email)).map((u) => u.email);
};

const resolveUserEmailsByIds = async (tenantId, ids) => {
  const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
  if (objectIds.length === 0) return [];
  const users = await UserModel.find({ _id: { $in: objectIds }, tenantId, status: "active" }).select("email").lean();
  return users.filter((u) => isEmailish(u.email)).map((u) => u.email);
};

/**
 * Returns [{ contact, source }] — zero, one, or several recipients. Never
 * throws; an unresolvable payload simply yields an empty array so the
 * caller can log NotConfigured honestly.
 */
const resolveRecipients = async ({ payload, tenantId }) => {
  // 1. A direct email address in the payload — the two legacy call sites
  // (CustomerController welcome_customer, UserController invitation_email)
  // and every SecurityNotificationRequested publisher use exactly this shape.
  if (isEmailish(payload.email)) return [{ contact: payload.email, source: "payload.email" }];

  // 2. AIAlertTriggered at "high" priority (this codebase's own stand-in for
  // critical/high severity — the raw severity itself isn't in the payload,
  // only the priority AIObservabilityService already derived from it) with
  // no direct recipient in the payload — route to the tenant's own
  // permission-holding admins (see resolveTenantAdmins above).
  if (payload.event === "AIAlertTriggered" && payload.priority === "high" && tenantId) {
    const admins = await resolveTenantAdmins(tenantId);
    if (admins.length > 0) return admins.map((email) => ({ contact: email, source: "tenantAdmin" }));
  }

  // 3. recipientId/recipientIds — meaning genuinely varies by call site: a
  // real User id in most (AI approvals, incident assignment), but already a
  // raw contact string in at least one (AmadeusFlightTicketingService).
  // Format-detection (not a business-rule guess) covers the raw-contact
  // case; a real User lookup covers the id case. Team/tier-only payloads
  // (incidentSlaScheduler) have no resolvable target and correctly fall through.
  const rawIds = Array.isArray(payload.recipientIds) ? payload.recipientIds : (payload.recipientId ? [payload.recipientId] : []);
  if (rawIds.length > 0) {
    const direct = rawIds.filter(isEmailish).map((contact) => ({ contact, source: "recipientId(direct)" }));
    if (tenantId) {
      const idsToLookUp = rawIds.filter((id) => !isEmailish(id));
      const emails = await resolveUserEmailsByIds(tenantId, idsToLookUp);
      direct.push(...emails.map((contact) => ({ contact, source: "recipientId" })));
    }
    if (direct.length > 0) return direct;
  }

  return [];
};

const buildMessage = (sourceEvent, payload) => {
  const label = payload.event || payload.type || sourceEvent;
  const { email: _email, ...context } = payload; // email already lives in `recipient` on the log row — drop it from the printed body.
  return {
    subject: `[${label}]`,
    body: `<p>${label}</p><pre>${JSON.stringify(context, null, 2)}</pre>`
  };
};

const deliverOne = async ({ tenantId, sourceEvent, event, channel, contact, source, payload, resolveAdapter }) => {
  const { subject, body } = buildMessage(sourceEvent, payload);
  const adapter = resolveAdapter(channel);
  let result;
  if (!adapter) result = { status: "NotConfigured", providerResponse: null, failureReason: `No delivery adapter is implemented for "${channel}" yet.` };
  else if (!contact) result = { status: "NotConfigured", providerResponse: null, failureReason: "No resolvable recipient contact found in the event payload." };
  else result = await adapter.send({ to: contact, subject, body });

  await NotificationLogModel.create({
    tenantId: tenantId || null, sourceEvent, event: event || null, channel, recipient: contact || null, recipientSource: source || null,
    status: result.status, providerResponse: result.providerResponse, failureReason: result.failureReason,
    context: { bookingId: payload.bookingId, incidentId: payload.incidentId, approvalRequestId: payload.approvalRequestId, alertId: payload.alertId, referenceId: payload.referenceId, visaCaseId: payload.visaCaseId, flightAssignmentId: payload.flightAssignmentId, travelPlanId: payload.travelPlanId }
  });
  return result;
};

class NotificationDeliveryService {
  static _eventListenersInitialized = false;

  /** `resolveAdapter` is injectable so tests can supply a stub transport instead of a live one — default is the real services/delivery/ adapters. */
  static initEventListeners({ resolveAdapter = getDeliveryAdapter } = {}) {
    if (NotificationDeliveryService._eventListenersInitialized) return;
    NotificationDeliveryService._eventListenersInitialized = true;

    subscribeEvent("NotificationRequested", async (payload) => {
      // Owned exclusively by CustomerCollectionService.initEventListeners()
      // (its own CollectionReminderModel logging + dunning side effects) —
      // handling it here too would double-send the same reminder.
      if (payload?.event === "ReceivableCollectionEscalated") return;
      try {
        const tenantId = payload?.tenantId || null;
        const channel = resolveChannel(payload);
        const recipients = await resolveRecipients({ payload, tenantId });
        if (recipients.length === 0) {
          await deliverOne({ tenantId, sourceEvent: "NotificationRequested", event: payload?.event || payload?.type, channel, contact: null, source: null, payload, resolveAdapter });
        } else {
          for (const { contact, source } of recipients) {
            await deliverOne({ tenantId, sourceEvent: "NotificationRequested", event: payload?.event || payload?.type, channel, contact, source, payload, resolveAdapter });
          }
        }
      } catch (error) {
        console.error("NotificationDeliveryService: NotificationRequested handling failed:", error);
      }
    });

    subscribeEvent("SecurityNotificationRequested", async (payload) => {
      try {
        const tenantId = payload?.tenantId || null;
        const channel = resolveChannel(payload);
        const contact = isEmailish(payload?.email) ? payload.email : null;
        await deliverOne({ tenantId, sourceEvent: "SecurityNotificationRequested", event: payload?.type, channel, contact, source: contact ? "payload.email" : null, payload: payload || {}, resolveAdapter });
      } catch (error) {
        console.error("NotificationDeliveryService: SecurityNotificationRequested handling failed:", error);
      }
    });

    subscribeEvent("SupplierNotificationRequested", async (payload) => {
      try {
        const tenantId = payload?.tenantId || null;
        const channel = resolveChannel(payload);
        // No supplier contact/webhook is ever carried on this payload today
        // (its one real publisher only sends { bookingId, tenantId, action })
        // — genuinely NotConfigured, not a bug in this listener.
        await deliverOne({ tenantId, sourceEvent: "SupplierNotificationRequested", event: payload?.action, channel, contact: null, source: null, payload: payload || {}, resolveAdapter });
      } catch (error) {
        console.error("NotificationDeliveryService: SupplierNotificationRequested handling failed:", error);
      }
    });
  }
}

export { resolveChannel, isEmailish, resolveRecipients, buildMessage };
export default NotificationDeliveryService;
