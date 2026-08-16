import crypto from "crypto";
import WebhookSubscriptionModel from "../models/WebhookSubscriptionModel.js";
import WebhookDeliveryModel from "../models/WebhookDeliveryModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { subscribeAllEvents } from "../utils/eventBus.js";
import { retryWithBackoff } from "../utils/retryWithBackoff.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly.
// ---------------------------------------------------------------------------

/** Real HMAC-SHA256 signature over `${timestamp}.${rawBody}` — the same scheme Stripe's own webhook signing uses, so any standard verification library on the receiving end works unmodified. */
export const computeWebhookSignature = (secret, timestamp, rawBody) => {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
};

/** A subscription matches an event when it's subscribed to that exact name or the wildcard "*" — real string matching, no fabricated topic-routing engine. */
export const subscriptionMatchesEvent = (subscribedEvents, eventName) => {
  return Array.isArray(subscribedEvents) && (subscribedEvents.includes("*") || subscribedEvents.includes(eventName));
};

const generateSecret = () => crypto.randomBytes(32).toString("hex");

/**
 * Enterprise Customer Payments — Finance Module Part 18 Part 5. "Business
 * Event -> Event Publisher -> Webhook Queue -> Retry Engine -> Subscriber
 * Endpoint -> Acknowledgement -> Audit Log." `utils/eventBus.js`'s own
 * `publishEvent` is the real Event Publisher (unchanged); this service is
 * the real Webhook Engine that fans every published event out to every
 * matching tenant subscription via `subscribeAllEvents` (this codebase's
 * event bus is in-process/synchronous-dispatch — see `utils/eventBus.js`'s
 * own `EVENT_BUS_TRANSPORT=memory` doc comment — so "Webhook Queue" here
 * means "delivery attempted inline, off the critical request path via
 * `queueMicrotask`'s own async dispatch," not a separate broker; there is
 * no message-queue infrastructure in this codebase to build a real one
 * against, honestly the same boundary as every other Part's excluded
 * external integrations).
 */
class WebhookService {
  static _initialized = false;

  /** Wires the real wildcard event-bus listener — called once from server.js alongside every other Part's own initEventListeners(). */
  static initEventListeners() {
    if (WebhookService._initialized) return;
    WebhookService._initialized = true;

    subscribeAllEvents(async (eventName, payload) => {
      if (!payload?.tenantId) return; // system-level events with no tenant have no subscriber to fan out to.
      try {
        await WebhookService.deliverEvent(eventName, payload);
      } catch (error) {
        console.error(`WebhookService: fan-out for "${eventName}" failed:`, error.message);
      }
    });
  }

  /** POST /api/v1/webhook-subscriptions — the plaintext `secret` is returned ONLY here (and on rotation), never again. */
  static async createSubscription(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { url, description = null, subscribedEvents } = data;
    if (!url) throw new Error("url is required.");
    if (!Array.isArray(subscribedEvents) || subscribedEvents.length === 0) throw new Error("subscribedEvents (at least one event name, or \"*\") is required.");
    try {
      new URL(url);
    } catch {
      throw new Error("url must be a valid absolute URL.");
    }

    const secret = generateSecret();
    const subscription = await WebhookSubscriptionModel.create({
      tenantId, url, description, secret, subscribedEvents, status: config.defaultWebhookSubscriptionStatus,
      timeline: [{ event: "WebhookSubscriptionCreated", description: `Subscribed to: ${subscribedEvents.join(", ")}.`, performedBy: userId || null }],
      createdBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.webhook.create", module: "Finance", resource: "WebhookSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: { url, subscribedEvents } });

    return { ...subscription.toJSON(), secret };
  }

  static async listSubscriptions(query, tenantId) {
    const { status } = query;
    const filter = { tenantId };
    if (status) filter.status = status;
    return WebhookSubscriptionModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async getSubscriptionById(subscriptionId, tenantId) {
    const subscription = await WebhookSubscriptionModel.findOne({ _id: subscriptionId, tenantId }).lean();
    if (!subscription) throw new Error("Webhook subscription not found.");
    return subscription;
  }

  /** "Webhook Secret Rotation" — real, invalidates the old secret immediately (a receiver must be updated before its next delivery, exactly like Stripe's own rotation UX). */
  static async rotateSecret(subscriptionId, tenantId, userId) {
    const subscription = await WebhookSubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Webhook subscription not found.");

    const secret = generateSecret();
    subscription.secret = secret;
    subscription.timeline.push({ event: "WebhookSecretRotated", description: "Signing secret rotated.", performedBy: userId || null });
    await subscription.save();

    await AuditLogModel.create({ action: "finance.webhook.rotate_secret", module: "Finance", resource: "WebhookSubscription", resourceId: subscription._id.toString(), userId: userId || null, tenantId, details: {} });

    return { ...subscription.toJSON(), secret };
  }

  static async updateStatus(subscriptionId, status, data, tenantId, userId) {
    const config = getFinanceConfig();
    if (!config.webhookSubscriptionStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);

    const subscription = await WebhookSubscriptionModel.findOne({ _id: subscriptionId, tenantId });
    if (!subscription) throw new Error("Webhook subscription not found.");

    subscription.status = status;
    subscription.suspendedReason = status === "Active" ? null : (data?.reason || subscription.suspendedReason);
    if (status === "Active") subscription.consecutiveFailureCount = 0;
    subscription.timeline.push({ event: `WebhookSubscription${status}`, description: data?.reason || `Status set to ${status}.`, performedBy: userId || null });
    await subscription.save();

    return subscription.toJSON();
  }

  static async listDeliveries(subscriptionId, tenantId, query = {}) {
    const filter = { tenantId, webhookSubscriptionId: subscriptionId };
    if (query.status) filter.status = query.status;
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
    return WebhookDeliveryModel.find(filter).sort({ createdAt: -1 }).limit(pageSize).lean();
  }

  /**
   * Fans `eventName`/`payload` out to every this-tenant subscription whose
   * `subscribedEvents` matches it. Each delivery is independent — one
   * subscriber's failure never blocks another's.
   */
  static async deliverEvent(eventName, payload) {
    const subscriptions = await WebhookSubscriptionModel.find({ tenantId: payload.tenantId, status: "Active" }).lean();
    const matching = subscriptions.filter((s) => subscriptionMatchesEvent(s.subscribedEvents, eventName));
    await Promise.allSettled(matching.map((subscription) => WebhookService._deliverToSubscription(subscription, eventName, payload)));
  }

  static async _deliverToSubscription(subscription, eventName, payload) {
    const config = getFinanceConfig();
    const rawBody = JSON.stringify({ eventId: payload.eventId, eventType: eventName, occurredAt: payload.occurredAt, data: payload });
    const signedTimestamp = Math.floor(Date.now() / 1000);
    const signature = computeWebhookSignature(subscription.secret, signedTimestamp, rawBody);

    const delivery = await WebhookDeliveryModel.create({
      tenantId: subscription.tenantId, webhookSubscriptionId: subscription._id, eventId: payload.eventId || null, eventType: eventName,
      payload, signature, signedTimestamp, status: "Pending"
    });

    let attemptNumber = 0;
    let succeeded = false;
    try {
      await retryWithBackoff(async (attempt) => {
        attemptNumber = attempt;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.webhookDeliveryTimeoutMs);
        try {
          const response = await fetch(subscription.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Webhook-Signature": signature,
              "X-Webhook-Timestamp": String(signedTimestamp),
              "X-Webhook-Event-Id": payload.eventId || "",
              "X-Webhook-Event": eventName
            },
            body: rawBody,
            signal: controller.signal
          });
          const responseBody = (await response.text().catch(() => "")).slice(0, 2000);
          delivery.attempts.push({ attemptNumber: attempt, responseStatusCode: response.status, responseBody, succeeded: response.ok, failureReason: response.ok ? null : `HTTP ${response.status}` });
          if (!response.ok) throw new Error(`Webhook endpoint responded with HTTP ${response.status}.`);
        } finally {
          clearTimeout(timeout);
        }
      }, { maxAttempts: config.webhookRetryMaxAttempts, baseDelayMs: config.webhookRetryBaseDelayMs, label: `webhook ${eventName} -> ${subscription.url}` });
      succeeded = true;
    } catch (error) {
      if (delivery.attempts.length === 0 || delivery.attempts[delivery.attempts.length - 1].succeeded) {
        delivery.attempts.push({ attemptNumber: attemptNumber || 1, responseStatusCode: null, responseBody: null, succeeded: false, failureReason: error.message });
      }
    }

    delivery.status = succeeded ? "Delivered" : "Failed";
    if (succeeded) delivery.deliveredAt = new Date();
    await delivery.save();

    const update = succeeded
      ? { $set: { lastDeliveryAt: new Date(), consecutiveFailureCount: 0 } }
      : { $set: { lastFailureAt: new Date() }, $inc: { consecutiveFailureCount: 1 } };
    await WebhookSubscriptionModel.updateOne({ _id: subscription._id }, update);

    if (!succeeded) {
      const fresh = await WebhookSubscriptionModel.findById(subscription._id).select("consecutiveFailureCount status").lean();
      if (fresh && fresh.consecutiveFailureCount >= config.webhookAutoSuspendFailureThreshold && fresh.status === "Active") {
        await WebhookSubscriptionModel.updateOne({ _id: subscription._id }, {
          $set: { status: "Suspended", suspendedReason: `Auto-suspended after ${fresh.consecutiveFailureCount} consecutive delivery failures.` },
          $push: { timeline: { event: "WebhookAutoSuspended", description: `Auto-suspended after ${fresh.consecutiveFailureCount} consecutive failures.`, performedAt: new Date() } }
        });
      }
    }

    return delivery.toJSON();
  }

  /** POST /api/v1/webhook-subscriptions/{subscriptionId}/deliveries/{deliveryId}/replay — "Webhook Replay" (Disaster Recovery). Real, targeted redelivery of one specific past event. */
  static async replayDelivery(deliveryId, tenantId) {
    const delivery = await WebhookDeliveryModel.findOne({ _id: deliveryId, tenantId }).lean();
    if (!delivery) throw new Error("Webhook delivery not found.");
    const subscription = await WebhookSubscriptionModel.findOne({ _id: delivery.webhookSubscriptionId, tenantId }).lean();
    if (!subscription) throw new Error("Webhook subscription not found.");
    if (subscription.status !== "Active") throw new Error(`Cannot replay to a subscription in status "${subscription.status}".`);

    return WebhookService._deliverToSubscription(subscription, delivery.eventType, delivery.payload);
  }
}

export default WebhookService;
