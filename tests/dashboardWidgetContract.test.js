import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWidget, toWidgetArray } from "../utils/dashboardWidgetContract.js";
import DashboardPreferenceModel from "../models/DashboardPreferenceModel.js";
import FinanceAnalyticsEngine from "../services/FinanceAnalyticsEngine.js";

test("normalizeWidget — throws on a missing widgetKey", () => {
  assert.throws(() => normalizeWidget({ type: "metric", title: "Cash Today" }), /widgetKey/);
});

test("normalizeWidget — throws on a missing type", () => {
  assert.throws(() => normalizeWidget({ widgetKey: "cashToday", title: "Cash Today" }), /type/);
});

test("normalizeWidget — throws on a missing title", () => {
  assert.throws(() => normalizeWidget({ widgetKey: "cashToday", type: "metric" }), /title/);
});

test("normalizeWidget — throws on an unconfigured widget type", () => {
  assert.throws(() => normalizeWidget({ widgetKey: "cashToday", type: "not-a-real-type", title: "Cash Today" }), /Invalid widget type/);
});

test("normalizeWidget — accepts a valid minimal widget", () => {
  const widget = normalizeWidget({ widgetKey: "cashToday", type: "metric", title: "Cash Today", value: 5000 });
  assert.equal(widget.widgetKey, "cashToday");
  assert.equal(widget.type, "metric");
  assert.equal(widget.title, "Cash Today");
  assert.equal(widget.value, 5000);
  assert.equal(widget.series, null);
  assert.deepEqual(widget.meta, {});
});

test("toWidgetArray — projects only the keys present in both the flat object and the keyMap", () => {
  const flat = { cashToday: 1000, outstandingAR: 500, someUnmappedField: "ignored" };
  const keyMap = { cashToday: { title: "Cash Today", type: "metric" }, outstandingAP: { title: "Outstanding Payables", type: "metric" } };

  const widgets = toWidgetArray(flat, keyMap);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].widgetKey, "cashToday");
  assert.equal(widgets[0].value, 1000);
});

test("toWidgetArray — never fabricates a widget for a field missing from the source object", () => {
  const widgets = toWidgetArray({}, { cashToday: { title: "Cash Today", type: "metric" } });
  assert.deepEqual(widgets, []);
});

test("toWidgetArray — carries fromCache/generatedAt through into each widget's meta", () => {
  const flat = { cashToday: 1000, fromCache: true, generatedAt: "2026-08-24T00:00:00.000Z" };
  const widgets = toWidgetArray(flat, { cashToday: { title: "Cash Today", type: "metric" } });
  assert.equal(widgets[0].meta.fromCache, true);
  assert.equal(widgets[0].meta.generatedAt, "2026-08-24T00:00:00.000Z");
});

test("toWidgetArray — returns an empty array for a null/undefined flatObject", () => {
  assert.deepEqual(toWidgetArray(null, { cashToday: { title: "Cash Today" } }), []);
  assert.deepEqual(toWidgetArray(undefined, { cashToday: { title: "Cash Today" } }), []);
});

const tenantId = "TENANT-TEST-DASHBOARDWIDGET-001";

test("FinanceAnalyticsEngine.getPreferences — queries DashboardPreferenceModel scoped to module: Finance", async () => {
  const origFindOne = DashboardPreferenceModel.findOne;
  let capturedQuery = null;
  try {
    DashboardPreferenceModel.findOne = (query) => {
      capturedQuery = query;
      return { lean: () => Promise.resolve(null) };
    };

    const result = await FinanceAnalyticsEngine.getPreferences({ tenantId, userId: "user-1", dashboardType: "Executive" });

    assert.equal(capturedQuery.module, "Finance");
    assert.equal(capturedQuery.dashboardType, "Executive");
    assert.equal(result.module, "Finance");
  } finally {
    DashboardPreferenceModel.findOne = origFindOne;
  }
});

test("FinanceAnalyticsEngine.savePreferences — upserts DashboardPreferenceModel with the compound {tenantId,userId,module,dashboardType} key", async () => {
  const origFindOneAndUpdate = DashboardPreferenceModel.findOneAndUpdate;
  let capturedFilter = null;
  let capturedUpdate = null;
  try {
    DashboardPreferenceModel.findOneAndUpdate = (filter, update) => {
      capturedFilter = filter;
      capturedUpdate = update;
      return Promise.resolve({ toJSON: () => ({ tenantId, userId: "user-1", module: "Finance", dashboardType: "Executive" }) });
    };

    await FinanceAnalyticsEngine.savePreferences({ tenantId, userId: "user-1", dashboardType: "Executive", theme: "dark" });

    assert.equal(capturedFilter.module, "Finance");
    assert.equal(capturedFilter.dashboardType, "Executive");
    assert.equal(capturedUpdate.$setOnInsert.module, "Finance");
  } finally {
    DashboardPreferenceModel.findOneAndUpdate = origFindOneAndUpdate;
  }
});

test("FinanceAnalyticsEngine.savePreferences — still rejects an unconfigured dashboardType without touching the DB", async () => {
  await assert.rejects(
    () => FinanceAnalyticsEngine.savePreferences({ tenantId, userId: "user-1", dashboardType: "NotARealDashboardType" }),
    /Invalid dashboardType/
  );
});
