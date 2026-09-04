import test from "node:test";
import assert from "node:assert/strict";
import CommunicationPlatformService from "../services/CommunicationPlatformService.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import TenantSubscriptionService from "../services/TenantSubscriptionService.js";

const tenantId = "TENANT-TEST-COMMRETRY-001";

const withMocked = async (mocks, fn) => {
  const originals = mocks.map(([obj, key]) => [obj, key, obj[key]]);
  try {
    for (const [obj, key, replacement] of mocks) obj[key] = replacement;
    await fn();
  } finally {
    for (const [obj, key, original] of originals) obj[key] = original;
  }
};

test("CommunicationPlatformService.processDueRetries — sweeps 'Failed' messages under maxRetries and retries each", async () => {
  const due = [
    { tenantId, messageId: "MSG-1", retryCount: 0, maxRetries: 3 },
    { tenantId, messageId: "MSG-2", retryCount: 1, maxRetries: 3 }
  ];
  const retried = [];

  await withMocked(
    [
      [CommunicationMessageModel, "find", () => ({ limit: () => ({ lean: async () => due }) })],
      [TenantSubscriptionService, "getEnforcementBlock", async () => null],
      [CommunicationPlatformService, "retryMessage", async ({ tenantId: t, messageId }) => { retried.push(messageId); return { messageId }; }]
    ],
    async () => {
      const processed = await CommunicationPlatformService.processDueRetries();
      assert.equal(processed, 2);
      assert.deepEqual(retried, ["MSG-1", "MSG-2"]);
    }
  );
});

test("CommunicationPlatformService.processDueRetries — skips messages for a suspended tenant, never calls retryMessage", async () => {
  const due = [{ tenantId, messageId: "MSG-SUSPENDED", retryCount: 0, maxRetries: 3 }];
  let retryMessageCalled = false;

  await withMocked(
    [
      [CommunicationMessageModel, "find", () => ({ limit: () => ({ lean: async () => due }) })],
      [TenantSubscriptionService, "getEnforcementBlock", async () => ({ reason: "Suspended" })],
      [CommunicationPlatformService, "retryMessage", async () => { retryMessageCalled = true; }]
    ],
    async () => {
      const processed = await CommunicationPlatformService.processDueRetries();
      assert.equal(processed, 0);
      assert.equal(retryMessageCalled, false);
    }
  );
});

test("CommunicationPlatformService.processDueRetries — one item's retryMessage failure does not stop the sweep", async () => {
  const due = [
    { tenantId, messageId: "MSG-FAILS-AGAIN", retryCount: 0, maxRetries: 3 },
    { tenantId, messageId: "MSG-OK", retryCount: 0, maxRetries: 3 }
  ];
  const retried = [];

  await withMocked(
    [
      [CommunicationMessageModel, "find", () => ({ limit: () => ({ lean: async () => due }) })],
      [TenantSubscriptionService, "getEnforcementBlock", async () => null],
      [CommunicationPlatformService, "retryMessage", async ({ messageId }) => {
        if (messageId === "MSG-FAILS-AGAIN") throw new Error("provider still down");
        retried.push(messageId);
      }]
    ],
    async () => {
      const processed = await CommunicationPlatformService.processDueRetries();
      assert.equal(processed, 1);
      assert.deepEqual(retried, ["MSG-OK"]);
    }
  );
});

test("CommunicationPlatformService.processDueRetries — query filters on status:'Failed', a cooldown window, and retryCount < maxRetries", async () => {
  let capturedQuery = null;

  await withMocked(
    [
      [CommunicationMessageModel, "find", (query) => { capturedQuery = query; return { limit: () => ({ lean: async () => [] }) }; }]
    ],
    async () => {
      await CommunicationPlatformService.processDueRetries();
      assert.equal(capturedQuery.status, "Failed");
      assert.ok(capturedQuery.updatedAt.$lte instanceof Date);
      assert.deepEqual(capturedQuery.$expr, { $lt: ["$retryCount", "$maxRetries"] });
    }
  );
});
