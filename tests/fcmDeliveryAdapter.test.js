import test from "node:test";
import assert from "node:assert/strict";
import FcmDeliveryAdapter from "../services/delivery/FcmDeliveryAdapter.js";

test("FcmDeliveryAdapter.send — honestly reports NotConfigured (never a fake success) when FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY are unset", async (t) => {
  if (process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY) {
    t.skip("FCM credentials are configured in this environment — NotConfigured path not exercised.");
    return;
  }

  const adapter = new FcmDeliveryAdapter();
  const result = await adapter.send({ to: "some-device-token", subject: "Hi", body: "Test", deepLink: { screen: "Home", params: {} } });

  assert.equal(result.status, "NotConfigured");
  assert.match(result.failureReason, /FCM_PROJECT_ID/);
});

test("FcmDeliveryAdapter.send — reports Failed (not NotConfigured) when a device token is missing entirely", async () => {
  const adapter = new FcmDeliveryAdapter();
  const result = await adapter.send({ to: null, subject: "Hi", body: "Test" });

  assert.equal(result.status, "Failed");
  assert.match(result.failureReason, /No device token/);
});
