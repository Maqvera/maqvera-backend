import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableCommunicationFailure, dispatchCommunicationWithResilience } from "../utils/communicationResilience.js";
import DeadLetterQueueModel from "../models/DeadLetterQueueModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";

test("isRetryableCommunicationFailure — classifies transient vs permanent failures per the 503-vs-550 example", () => {
  assert.equal(isRetryableCommunicationFailure(new Error("Provider responded with HTTP 503 Service Unavailable")), true);
  assert.equal(isRetryableCommunicationFailure(new Error("Connection timed out while reaching SMTP host")), true);
  assert.equal(isRetryableCommunicationFailure(new Error("Too many requests - rate limit exceeded")), true);
  assert.equal(isRetryableCommunicationFailure({ name: "AbortError", message: "aborted" }), true);
  assert.equal(isRetryableCommunicationFailure({ code: "ECONNRESET", message: "socket hang up" }), true);

  assert.equal(isRetryableCommunicationFailure(new Error("550 Invalid Email Address")), false);
  assert.equal(isRetryableCommunicationFailure(new Error("SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS).")), false);
  assert.equal(isRetryableCommunicationFailure(new Error("No such recipient")), false);
  assert.equal(isRetryableCommunicationFailure(new Error("No email address available for this recipient.")), false);
  assert.equal(isRetryableCommunicationFailure(new Error("totally unclassified failure")), false, "unrecognized text is never retried by default");
});

test("dispatchCommunicationWithResilience — a successful send passes the result straight through", async () => {
  const result = await dispatchCommunicationWithResilience({
    channel: "Email",
    tenantId: "TENANT-TEST-COMRES-001",
    messageId: "MSG-SUCCESS-1",
    recipient: { email: "ok@example.com" },
    run: async () => ({ status: "Sent", providerResponse: { messageId: "abc" } })
  });

  assert.equal(result.status, "Sent");
});

test("dispatchCommunicationWithResilience — a permanent failure is queued to the shared Dead Letter Queue, never retried, never silently dropped", async () => {
  const origCreate = DeadLetterQueueModel.create;
  const origAuditCreate = AuditLogModel.create;
  const created = [];

  try {
    DeadLetterQueueModel.create = async (doc) => {
      const row = { ...doc, _id: "DLQ-FAKE-1" };
      created.push(row);
      return row;
    };
    AuditLogModel.create = async (doc) => doc;

    let attemptCount = 0;

    await assert.rejects(
      async () => {
        await dispatchCommunicationWithResilience({
          channel: "Email",
          tenantId: "TENANT-TEST-COMRES-001",
          messageId: "MSG-PERMANENT-1",
          recipient: { email: "bad@example.com" },
          run: async () => {
            attemptCount += 1;
            throw new Error("No email address available for this recipient.");
          }
        });
      },
      (err) => {
        assert.equal(err.dlqId, "DLQ-FAKE-1");
        return true;
      }
    );

    // Non-retryable — exactly one attempt, no backoff/retry loop.
    assert.equal(attemptCount, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].integration, "Email");
    assert.equal(created[0].module, "Communication");
    assert.equal(created[0].tenantId, "TENANT-TEST-COMRES-001");
  } finally {
    DeadLetterQueueModel.create = origCreate;
    AuditLogModel.create = origAuditCreate;
  }
});
