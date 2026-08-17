import { EventEmitter } from "events";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import DomainEventModel from "../models/DomainEventModel.js";
import { getCorrelationId } from "./correlationContext.js";

const eventBus = new EventEmitter();
const outboxEnabled = !["false", "0", "off", "no"].includes(String(process.env.EVENT_OUTBOX_ENABLED || "true").toLowerCase());

// Wildcard listeners — invoked for EVERY published event regardless of
// name, alongside the named listeners above. Node's own EventEmitter has
// no wildcard event name, so this is a small, separate registry rather
// than a fake "*" event. Added for the Webhook Platform (Finance Module
// Part 18 Part 5) — "Payment Authorized... Custom Events... Everything
// configurable" needs to fan out ANY event name a tenant subscribes to,
// including ones not known ahead of time, not just a fixed enumerated
// list re-subscribed to individually.
const wildcardListeners = [];
export const subscribeAllEvents = (listener) => {
    wildcardListeners.push(listener);
};

export const publishEvent = (eventName, payload = {}) => {
    const eventId = payload.eventId || uuidv4();
    const occurredAt = new Date();
    // Enterprise Correlation & Traceability Standard — "Every published
    // event MUST include the Correlation-ID." An explicit
    // `payload.correlationId` always wins (a caller propagating a DIFFERENT
    // request's correlationId on purpose, e.g. a scheduler replaying a
    // stored event, is a deliberate choice); otherwise this falls back to
    // the CURRENT request's correlationId via AsyncLocalStorage
    // (utils/correlationContext.js) — real for every one of this
    // codebase's existing `publishEvent(...)` call sites automatically,
    // with zero changes to any of them. Outside any request context (a
    // cron scheduler) this is honestly `null`, never fabricated.
    const correlationId = payload.correlationId || getCorrelationId() || null;
    const eventPayload = { ...payload, eventId, correlationId, occurredAt: payload.occurredAt || occurredAt };

    // Persist a replayable event record when the database is available. Event
    // delivery remains non-blocking for existing command handlers.
    const eventRecordPromise = outboxEnabled && mongoose.connection.readyState === 1
        ? DomainEventModel.create({
            eventId,
            eventType: eventName,
            tenantId: eventPayload.tenantId || null,
            correlationId: eventPayload.correlationId || null,
            payload: eventPayload,
            occurredAt,
            deliveryStatus: "queued",
        }).catch((error) => {
            console.error(`Domain event persistence failed for ${eventName}:`, error.message);
            return null;
        })
        : Promise.resolve(null);

    queueMicrotask(async () => {
        const namedCalls = eventBus.listeners(eventName).map((listener) => listener(eventPayload));
        const wildcardCalls = wildcardListeners.map((listener) => listener(eventName, eventPayload));
        const results = await Promise.allSettled([...namedCalls, ...wildcardCalls]);
        const failures = results.filter((result) => result.status === "rejected");
        const eventRecord = await eventRecordPromise;
        if (eventRecord) {
            await DomainEventModel.updateOne(
                { _id: eventRecord._id },
                failures.length
                    ? { $set: { deliveryStatus: "dispatch_failed", failureReason: failures.map((item) => item.reason?.message || "Listener failed").join("; ") } }
                    : { $set: { deliveryStatus: "dispatched", dispatchedAt: new Date() } }
            ).catch(() => null);
        }
        for (const failure of failures) console.error(`Domain event listener failed for ${eventName}:`, failure.reason);
    });
    return eventId;
};

export const subscribeEvent = (eventName, listener) => {
    eventBus.on(eventName, listener);
};

export default eventBus;
