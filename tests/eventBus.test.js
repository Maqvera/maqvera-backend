import test from "node:test";
import assert from "node:assert/strict";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";

test("event bus dispatches an envelope without requiring a database connection", async () => {
  const eventName = `EventBusTest_${Date.now()}`;
  const delivered = new Promise((resolve) => subscribeEvent(eventName, resolve));
  const eventId = publishEvent(eventName, { tenantId: "tenant_test", branchId: "branch_test" });
  const payload = await delivered;
  assert.equal(payload.eventId, eventId);
  assert.equal(payload.tenantId, "tenant_test");
  assert.ok(payload.occurredAt);
});
