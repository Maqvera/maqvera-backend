import test from "node:test";
import assert from "node:assert/strict";
import { buildCampaignFilter, computeCollectionPriority } from "../services/CollectionCampaignService.js";

test("buildCampaignFilter builds a real Mongo filter from targetCriteria, only including what's set", () => {
  const filter = buildCampaignFilter("tenant-1", { status: "Overdue", minAmount: 1000, maxAmount: 5000, minDaysOverdue: 30 });
  assert.equal(filter.tenantId, "tenant-1");
  assert.equal(filter.status, "Overdue");
  assert.deepEqual(filter.totalAmount, { $gte: 1000, $lte: 5000 });
  assert.ok(filter.paymentDueDate.$lte instanceof Date);
});

test("buildCampaignFilter omits keys that were never set", () => {
  const filter = buildCampaignFilter("tenant-1", {});
  assert.deepEqual(filter, { tenantId: "tenant-1" });
});

test("computeCollectionPriority scores VIP/high-amount/old-overdue collections higher", () => {
  const low = computeCollectionPriority({ amount: 100, daysOverdue: 0, customerCategory: "regular" });
  const high = computeCollectionPriority({ amount: 150000, daysOverdue: 90, customerCategory: "vip", collectionStage: "Legal Escalation" });
  assert.equal(low.label, "Low");
  assert.equal(high.label, "Critical");
  assert.ok(high.score > low.score);
  assert.ok(high.score <= 100);
});
