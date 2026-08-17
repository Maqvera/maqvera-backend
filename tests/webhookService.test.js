import test from "node:test";
import assert from "node:assert/strict";
import { computeWebhookSignature, subscriptionMatchesEvent } from "../services/WebhookService.js";

test("computeWebhookSignature is a deterministic HMAC-SHA256 hex digest over timestamp.body", () => {
  const sig1 = computeWebhookSignature("secret123", 1700000000, '{"a":1}');
  const sig2 = computeWebhookSignature("secret123", 1700000000, '{"a":1}');
  assert.equal(sig1, sig2);
  assert.equal(sig1.length, 64); // hex-encoded SHA-256
  assert.match(sig1, /^[0-9a-f]{64}$/);
});

test("computeWebhookSignature changes with the secret, timestamp, or body", () => {
  const base = computeWebhookSignature("secret123", 1700000000, '{"a":1}');
  assert.notEqual(computeWebhookSignature("different-secret", 1700000000, '{"a":1}'), base);
  assert.notEqual(computeWebhookSignature("secret123", 1700000001, '{"a":1}'), base);
  assert.notEqual(computeWebhookSignature("secret123", 1700000000, '{"a":2}'), base);
});

test("subscriptionMatchesEvent matches an exact event name or the wildcard", () => {
  assert.equal(subscriptionMatchesEvent(["PaymentCaptured", "PaymentFailed"], "PaymentCaptured"), true);
  assert.equal(subscriptionMatchesEvent(["PaymentCaptured"], "PaymentFailed"), false);
  assert.equal(subscriptionMatchesEvent(["*"], "AnyCustomEventName"), true);
  assert.equal(subscriptionMatchesEvent([], "PaymentCaptured"), false);
  assert.equal(subscriptionMatchesEvent(undefined, "PaymentCaptured"), false);
});
