import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Joi from "joi";
import { runWithCorrelationId } from "../utils/correlationContext.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Event Versioning Standard
// (Improvement 7). Proves the real standard envelope, real duplicate-
// definition prevention, real schema validation, and the real
// Active -> Deprecated -> Retired lifecycle, all as a genuinely NEW,
// additive publishing path that never touches the existing, untouched
// `publishEvent` every other event in this codebase still uses unchanged.
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("registerEvent: idempotent re-registration, real conflict on a different owner/category", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { registerEvent } = await import("../utils/eventVersioning.js");
  const EventRegistryModel = (await import("../models/EventRegistryModel.js")).default;

  const eventName = `TestEvent${Date.now()}`;
  t.after(async () => { await EventRegistryModel.deleteMany({ eventName }); });

  const first = await registerEvent(eventName, 1, { category: "Domain", owner: "Invoice Platform" });
  assert.equal(first.status, "Active");

  const again = await registerEvent(eventName, 1, { category: "Domain", owner: "Invoice Platform" });
  assert.equal(String(again._id), String(first._id), "re-registering with the SAME owner/category is a safe idempotent no-op");

  await assert.rejects(
    () => registerEvent(eventName, 1, { category: "Domain", owner: "A Different Team" }),
    (error) => {
      assert.equal(error.code, "EVENT_REGISTRY_CONFLICT");
      assert.equal(error.httpStatus, 409);
      return true;
    }
  );
});

test("publishVersionedEvent: real standard envelope, real .vN event key, ambient correlationId, never reaches an unversioned listener", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { publishVersionedEvent } = await import("../utils/eventVersioning.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const EventRegistryModel = (await import("../models/EventRegistryModel.js")).default;

  const eventName = `InvoiceCreatedTest${Date.now()}`;
  t.after(async () => { await EventRegistryModel.deleteMany({ eventName }); });

  let versionedReceived = null;
  let unversionedReceived = null;
  subscribeEvent(`${eventName}.v1`, (payload) => { versionedReceived = payload; });
  subscribeEvent(eventName, (payload) => { unversionedReceived = payload; });

  const tenantId = `test-ev-${Date.now()}`;
  await runWithCorrelationId("corr-event-versioning", async () => {
    await publishVersionedEvent({
      eventName, version: 1, category: "Domain", owner: "Invoice Platform", source: "Invoice Platform",
      tenantId, data: { invoiceId: "INV-1001", amount: 1000 }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.ok(versionedReceived, "the .v1 subscriber must receive the event");
  assert.equal(unversionedReceived, null, "an unversioned listener for the bare event name must NEVER receive a versioned publish — genuinely separate event keys");

  assert.equal(versionedReceived.eventName, eventName);
  assert.equal(versionedReceived.eventVersion, "1.0");
  assert.equal(versionedReceived.tenantId, tenantId);
  assert.equal(versionedReceived.source, "Invoice Platform");
  assert.equal(versionedReceived.correlationId, "corr-event-versioning");
  assert.ok(versionedReceived.eventId);
  assert.deepEqual(versionedReceived.data, { invoiceId: "INV-1001", amount: 1000 }, "the real payload lives nested under data, per the standard envelope");

  await new Promise((resolve) => setTimeout(resolve, 30));
  const registryEntry = await EventRegistryModel.findOne({ eventName, version: 1 }).lean();
  assert.equal(registryEntry.publishCount, 1);
  assert.ok(registryEntry.lastPublishedAt);
});

test("publishVersionedEvent: real Joi schema validation rejects an invalid payload before publishing", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { publishVersionedEvent, registerEventSchema } = await import("../utils/eventVersioning.js");
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const EventRegistryModel = (await import("../models/EventRegistryModel.js")).default;

  const eventName = `SchemaValidatedEvent${Date.now()}`;
  t.after(async () => { await EventRegistryModel.deleteMany({ eventName }); });

  registerEventSchema(eventName, 1, Joi.object({ invoiceId: Joi.string().required(), amount: Joi.number().greater(0).required() }));

  let received = null;
  subscribeEvent(`${eventName}.v1`, (payload) => { received = payload; });

  await assert.rejects(
    () => publishVersionedEvent({ eventName, version: 1, category: "Domain", owner: "Invoice Platform", source: "Invoice Platform", data: { amount: -5 } }),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.ok(error.details.some((d) => d.field === "invoiceId"));
      assert.ok(error.details.some((d) => d.field === "amount"));
      return true;
    }
  );
  assert.equal(received, null, "an invalid payload must never actually be published");

  await publishVersionedEvent({ eventName, version: 1, category: "Domain", owner: "Invoice Platform", source: "Invoice Platform", data: { invoiceId: "INV-1", amount: 100 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(received, "a valid payload publishes normally");
});

test("Event lifecycle: Active -> Deprecated (still publishes) -> Retired (publish rejected) -> Reactivate is blocked once Retired", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { publishVersionedEvent, deprecateEventVersion, retireEventVersion, reactivateEventVersion, registerEvent } = await import("../utils/eventVersioning.js");
  const EventRegistryModel = (await import("../models/EventRegistryModel.js")).default;

  const eventName = `LifecycleEvent${Date.now()}`;
  t.after(async () => { await EventRegistryModel.deleteMany({ eventName }); });

  await registerEvent(eventName, 1, { category: "System", owner: "Platform Team" });

  const deprecated = await deprecateEventVersion(eventName, 1, "Superseded by v2.", "ops-user");
  assert.equal(deprecated.status, "Deprecated");
  assert.ok(deprecated.deprecatedAt);

  // "Old versions MUST remain available during migration" — a Deprecated
  // version still genuinely publishes.
  const eventId = await publishVersionedEvent({ eventName, version: 1, category: "System", owner: "Platform Team", source: "Platform", data: { ok: true } });
  assert.ok(eventId);

  const retired = await retireEventVersion(eventName, 1, "ops-user");
  assert.equal(retired.status, "Retired");
  assert.ok(retired.retiredAt);

  await assert.rejects(
    () => publishVersionedEvent({ eventName, version: 1, category: "System", owner: "Platform Team", source: "Platform", data: {} }),
    (error) => {
      assert.equal(error.code, "EVENT_VERSION_RETIRED");
      assert.equal(error.httpStatus, 410);
      return true;
    }
  );

  await assert.rejects(() => reactivateEventVersion(eventName, 1, "ops-user"), /Cannot reactivate a Retired/);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
