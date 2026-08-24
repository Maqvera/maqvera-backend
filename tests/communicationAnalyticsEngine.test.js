import test from "node:test";
import assert from "node:assert/strict";
import CommunicationAnalyticsEngine from "../services/CommunicationAnalyticsEngine.js";
import CommunicationMessageModel from "../models/CommunicationMessageModel.js";
import CommunicationAnalyticsSummaryModel from "../models/CommunicationAnalyticsSummaryModel.js";
import CacheManager from "../utils/cacheManager.js";

const tenantId = "TENANT-TEST-COMMANALYTICS-001";

test("CommunicationAnalyticsEngine.computeCommunicationMetrics — treats both 'Delivered' and legacy 'Sent' as delivered, computes delivery rate", async () => {
  const origAggregate = CommunicationMessageModel.aggregate;
  const origCount = CommunicationMessageModel.countDocuments;

  try {
    let call = 0;
    CommunicationMessageModel.aggregate = async (pipeline) => {
      call += 1;
      // 1st call: status group, 2nd: channel group, 3rd: provider group, 4th: latency group
      if (call === 1) return [{ _id: "Delivered", count: 7 }, { _id: "Failed", count: 2 }, { _id: "Queued", count: 1 }];
      if (call === 2) return [{ _id: "Email", total: 5, delivered: 4, failed: 1 }, { _id: "SMS", total: 5, delivered: 3, failed: 1 }];
      if (call === 3) return [{ _id: "Twilio", count: 5 }, { _id: "Nodemailer SMTP", count: 4 }];
      return [{ _id: null, avgLatencyMs: 1500 }];
    };
    CommunicationMessageModel.countDocuments = async () => 1;

    const metrics = await CommunicationAnalyticsEngine.computeCommunicationMetrics({ tenantId });

    assert.equal(metrics.totalMessages, 10);
    assert.equal(metrics.deliveredCount, 7);
    assert.equal(metrics.failedCount, 2);
    assert.equal(metrics.queuedCount, 1);
    assert.equal(metrics.deliveryRate, 70);
    assert.equal(metrics.byChannel.Email.deliveryRate, 80);
    assert.equal(metrics.byProvider.length, 2);
    assert.equal(metrics.dlqCount, 1);
    assert.equal(metrics.avgDeliveryLatencyMs, 1500);
  } finally {
    CommunicationMessageModel.aggregate = origAggregate;
    CommunicationMessageModel.countDocuments = origCount;
  }
});

test("CommunicationAnalyticsEngine.refreshSummary — persists into CommunicationAnalyticsSummaryModel keyed by (tenantId, today), never a live-query-only result", async () => {
  const origAggregate = CommunicationMessageModel.aggregate;
  const origCount = CommunicationMessageModel.countDocuments;
  const origUpsert = CommunicationAnalyticsSummaryModel.findOneAndUpdate;
  const origInvalidate = CacheManager.invalidatePattern;

  let upsertQuery = null;
  let upsertDoc = null;

  try {
    CommunicationMessageModel.aggregate = async () => [];
    CommunicationMessageModel.countDocuments = async () => 0;
    CommunicationAnalyticsSummaryModel.findOneAndUpdate = async (query, doc) => { upsertQuery = query; upsertDoc = doc; return doc; };
    CacheManager.invalidatePattern = async () => {};

    await CommunicationAnalyticsEngine.refreshSummary({ tenantId });

    assert.equal(upsertQuery.tenantId, tenantId);
    assert.match(upsertQuery.summaryDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(upsertDoc.metrics);
    assert.ok(upsertDoc.generatedAt instanceof Date);
  } finally {
    CommunicationMessageModel.aggregate = origAggregate;
    CommunicationMessageModel.countDocuments = origCount;
    CommunicationAnalyticsSummaryModel.findOneAndUpdate = origUpsert;
    CacheManager.invalidatePattern = origInvalidate;
  }
});

test("CommunicationAnalyticsEngine.getCommunicationAnalytics — backward-compatible shape for the existing GET /communication/analytics endpoint", async () => {
  const origGet = CacheManager.getOrCompute;
  try {
    CacheManager.getOrCompute = async (_key, compute) => ({ data: await compute(), fromCache: false });
    // ensureSummary will find nothing and schedule a background refresh (queueMicrotask) —
    // the immediate return is the honest "pendingRefresh" placeholder, which is exactly
    // what getCommunicationAnalytics must still shape correctly.
    const origFindOne = CommunicationAnalyticsSummaryModel.findOne;
    CommunicationAnalyticsSummaryModel.findOne = () => ({ lean: async () => null });

    const analytics = await CommunicationAnalyticsEngine.getCommunicationAnalytics({ tenantId });

    assert.equal(analytics.totalMessages, 0);
    assert.equal(analytics.deliveryRate, 100.0);
    assert.equal(analytics.pendingRefresh, true);
    assert.ok("byChannel" in analytics);
    assert.ok("dlqCount" in analytics);

    CommunicationAnalyticsSummaryModel.findOne = origFindOne;
  } finally {
    CacheManager.getOrCompute = origGet;
  }
});
