import test from "node:test";
import assert from "node:assert/strict";
import ProviderRouter from "../services/delivery/ProviderRouter.js";
import eventBus, { subscribeEvent } from "../utils/eventBus.js";

const okAdapter = (name, response = { sid: "OK" }) => ({ name, instance: { send: async () => ({ status: "Sent", providerResponse: response, failureReason: null }) } });
const failAdapter = (name, reason = "unavailable") => ({ name, instance: { send: async () => ({ status: "Failed", providerResponse: null, failureReason: reason }) } });
const throwingAdapter = (name, message = "boom") => ({ name, instance: { send: async () => { throw new Error(message); } } });

test("ProviderRouter.send — succeeds on the first adapter, no failover", async () => {
  const router = new ProviderRouter("TestChannel", [okAdapter("ProviderA"), okAdapter("ProviderB")]);
  const result = await router.send({ to: "x" });

  assert.equal(result.status, "Sent");
  assert.equal(result.provider, "ProviderA");
  assert.equal(result.failoverOccurred, false);
  assert.equal(result.attempts.length, 0);
});

test("ProviderRouter.send — fails over to the next provider and publishes ProviderSwitched", async () => {
  const router = new ProviderRouter("TestChannel", [failAdapter("ProviderA", "down"), okAdapter("ProviderB")]);

  let switchedEvent = null;
  const listener = (payload) => { switchedEvent = payload; };
  subscribeEvent("ProviderSwitched", listener);

  try {
    const result = await router.send({ tenantId: "TENANT-X", messageId: "MSG-1", to: "x" });

    assert.equal(result.status, "Sent");
    assert.equal(result.provider, "ProviderB");
    assert.equal(result.failoverOccurred, true);
    assert.equal(result.initialProvider, "ProviderA");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].provider, "ProviderA");

    // publishEvent dispatches via queueMicrotask — let it flush.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(switchedEvent, "ProviderSwitched must be published on failover");
    assert.equal(switchedEvent.fromProvider, "ProviderA");
    assert.equal(switchedEvent.toProvider, "ProviderB");
    assert.equal(switchedEvent.channel, "TestChannel");
  } finally {
    eventBus.off("ProviderSwitched", listener);
  }
});

test("ProviderRouter.send — an adapter that throws is recorded as an attempt, not left uncaught", async () => {
  const router = new ProviderRouter("TestChannel", [throwingAdapter("ProviderA", "network error"), okAdapter("ProviderB")]);
  const result = await router.send({ to: "x" });

  assert.equal(result.status, "Sent");
  assert.equal(result.provider, "ProviderB");
  assert.equal(result.attempts[0].status, "Error");
  assert.equal(result.attempts[0].reason, "network error");
});

test("ProviderRouter.send — every provider failing returns status:Failed with the full attempt trail, never throws", async () => {
  const router = new ProviderRouter("TestChannel", [failAdapter("ProviderA", "down"), failAdapter("ProviderB", "also down")]);
  const result = await router.send({ to: "x" });

  assert.equal(result.status, "Failed");
  assert.equal(result.provider, "ProviderA");
  assert.equal(result.attempts.length, 2);
  assert.match(result.failureReason, /also down/);
});

test("ProviderRouter.send — preferredProvider reorders the chain to try that provider first", async () => {
  const router = new ProviderRouter("TestChannel", [okAdapter("ProviderA"), okAdapter("ProviderB")]);
  const result = await router.send({ to: "x", preferredProvider: "providerb" });

  assert.equal(result.provider, "ProviderB");
  assert.equal(result.failoverOccurred, false);
});
