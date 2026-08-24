import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import ReportUsageAnalyticsService from "../services/ReportUsageAnalyticsService.js";
import ReportUsageSummaryModel from "../models/ReportUsageSummaryModel.js";

const tenantId = "TENANT-TEST-REPORTUSAGE-001";

test("ReportUsageAnalyticsService.recordView — no-ops without a live Mongo connection, never throws", async () => {
  assert.notEqual(mongoose.connection?.readyState, 1, "this test assumes no live DB connection, matching the rest of this suite");
  const result = await ReportUsageAnalyticsService.recordView({ tenantId, module: "Finance", dashboardType: "Executive", performedBy: "u1", resourceType: "Dashboard" });
  assert.equal(result, null);
});

test("ReportUsageAnalyticsService.recordView — upserts with $inc viewCount and $addToSet uniqueUserIds", async () => {
  const origState = mongoose.connection.readyState;
  const origFindOneAndUpdate = ReportUsageSummaryModel.findOneAndUpdate;
  try {
    mongoose.connection.readyState = 1;
    let capturedFilter = null;
    let capturedUpdate = null;
    ReportUsageSummaryModel.findOneAndUpdate = async (filter, update) => {
      capturedFilter = filter;
      capturedUpdate = update;
      return { tenantId, ...filter };
    };

    await ReportUsageAnalyticsService.recordView({ tenantId, module: "Finance", dashboardType: "Executive", performedBy: "u1", resourceType: "Dashboard" });

    assert.equal(capturedFilter.tenantId, tenantId);
    assert.equal(capturedFilter.module, "Finance");
    assert.equal(capturedFilter.resourceType, "Dashboard");
    assert.equal(capturedFilter.reportKey, "Executive");
    assert.equal(capturedUpdate.$inc.viewCount, 1);
    assert.deepEqual(capturedUpdate.$addToSet, { uniqueUserIds: "u1" });
    assert.ok(capturedUpdate.$set.lastViewedAt instanceof Date);
  } finally {
    mongoose.connection.readyState = origState;
    ReportUsageSummaryModel.findOneAndUpdate = origFindOneAndUpdate;
  }
});

test("ReportUsageAnalyticsService.recordView — two same-day views increment rather than overwrite", async () => {
  const origState = mongoose.connection.readyState;
  const origFindOneAndUpdate = ReportUsageSummaryModel.findOneAndUpdate;
  try {
    mongoose.connection.readyState = 1;
    const store = new Map();
    ReportUsageSummaryModel.findOneAndUpdate = async (filter) => {
      const key = `${filter.tenantId}::${filter.module}::${filter.resourceType}::${filter.reportKey}::${filter.periodDate}`;
      const existing = store.get(key) || { viewCount: 0, uniqueUserIds: [] };
      existing.viewCount += 1;
      store.set(key, existing);
      return existing;
    };

    await ReportUsageAnalyticsService.recordView({ tenantId, module: "Visa", dashboardType: "Officer", performedBy: "u1", resourceType: "Dashboard" });
    await ReportUsageAnalyticsService.recordView({ tenantId, module: "Visa", dashboardType: "Officer", performedBy: "u2", resourceType: "Dashboard" });

    const [[, stored]] = [...store.entries()];
    assert.equal(stored.viewCount, 2, "second view must increment, not overwrite, the same day's row");
  } finally {
    mongoose.connection.readyState = origState;
    ReportUsageSummaryModel.findOneAndUpdate = origFindOneAndUpdate;
  }
});

test("ReportUsageAnalyticsService.recordExport — upserts with $inc exportCount", async () => {
  const origState = mongoose.connection.readyState;
  const origFindOneAndUpdate = ReportUsageSummaryModel.findOneAndUpdate;
  try {
    mongoose.connection.readyState = 1;
    let capturedUpdate = null;
    ReportUsageSummaryModel.findOneAndUpdate = async (filter, update) => { capturedUpdate = update; return {}; };

    await ReportUsageAnalyticsService.recordExport({ tenantId, module: "Finance", reportType: "TrialBalance", format: "CSV", performedBy: "u1", resourceType: "Report" });

    assert.equal(capturedUpdate.$inc.exportCount, 1);
    assert.ok(capturedUpdate.$set.lastExportedAt instanceof Date);
  } finally {
    mongoose.connection.readyState = origState;
    ReportUsageSummaryModel.findOneAndUpdate = origFindOneAndUpdate;
  }
});

test("ReportUsageAnalyticsService.recordView/recordExport — no-op without tenantId/module/reportKey, never throws", async () => {
  const origState = mongoose.connection.readyState;
  try {
    mongoose.connection.readyState = 1;
    assert.equal(await ReportUsageAnalyticsService.recordView({ module: "Finance", dashboardType: "x", resourceType: "Dashboard" }), null);
    assert.equal(await ReportUsageAnalyticsService.recordExport({ tenantId, dashboardType: "x", resourceType: "Dashboard" }), null);
  } finally {
    mongoose.connection.readyState = origState;
  }
});

test("ReportUsageAnalyticsService.getUsageSummary — requires tenantId", async () => {
  await assert.rejects(() => ReportUsageAnalyticsService.getUsageSummary({}), /tenantId is required/);
});

test("ReportUsageAnalyticsService.getUsageSummary — queries the pre-aggregated summary collection, not raw events", async () => {
  const origFind = ReportUsageSummaryModel.find;
  try {
    let capturedQuery = null;
    ReportUsageSummaryModel.find = (query) => {
      capturedQuery = query;
      return { sort: () => ({ lean: async () => [] }) };
    };

    await ReportUsageAnalyticsService.getUsageSummary({ tenantId, module: "Finance", resourceType: "Dashboard", days: 7 });

    assert.equal(capturedQuery.tenantId, tenantId);
    assert.equal(capturedQuery.module, "Finance");
    assert.equal(capturedQuery.resourceType, "Dashboard");
    assert.ok(capturedQuery.periodDate.$gte);
  } finally {
    ReportUsageSummaryModel.find = origFind;
  }
});
