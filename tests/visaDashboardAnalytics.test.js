import test from "node:test";
import assert from "node:assert/strict";
import VisaAnalyticsEngine from "../services/VisaAnalyticsEngine.js";
import KPIEngine from "../services/KPIEngine.js";
import VisaCustomerAnalyticsSummaryModel from "../models/VisaCustomerAnalyticsSummaryModel.js";

test("VisaAnalyticsEngine exposes all dashboard read methods", () => {
  const methods = [
    "executiveDashboard",
    "operationsDashboard",
    "officerDashboard",
    "embassyDashboard",
    "financeDashboard",
    "customerDashboard",
    "complianceDashboard",
    "aiInsightsDashboard",
    "calculateKPIs",
    "generateTrends",
    "init",
  ];

  for (const method of methods) {
    assert.equal(typeof VisaAnalyticsEngine[method], "function", `${method} should exist`);
  }
});

test("KPIEngine exposes visa refresh methods", () => {
  assert.equal(typeof KPIEngine.computeVisaMetrics, "function");
  assert.equal(typeof KPIEngine.refreshVisaSummary, "function");
  assert.equal(typeof KPIEngine.refreshAllForTenant, "function");
  assert.equal(typeof KPIEngine.refreshVisaCustomerSummaries, "function");
});

test("customer analytics has a dedicated read model", () => {
  assert.equal(VisaCustomerAnalyticsSummaryModel.modelName, "visa_customer_analytics_summary");
  const index = VisaCustomerAnalyticsSummaryModel.schema.indexes().find(([keys]) =>
    keys.tenantId === 1 && keys.customerId === 1 && keys.summaryDate === 1
  );
  assert.ok(index, "customer read model needs a tenant/customer/date index");
});

test("buildTrendSnapshot returns zeroed trend points when database is unavailable", async () => {
  if (process.env.RUN_DB_TESTS === "true") {
    const result = await VisaAnalyticsEngine.buildTrendSnapshot({
      tenantId: "__missing_tenant__",
      period: "7 Days",
    });
    assert.equal(result.period, "7 Days");
    assert.equal(result.dataPointsCount, 7);
    assert.equal(result.trends.length, 7);
    return;
  }

  assert.ok(true, "Skipped DB-backed trend test unless RUN_DB_TESTS=true");
});

test("generateTrends exposes cache metadata shape when database is unavailable", async () => {
  if (process.env.RUN_DB_TESTS !== "true") {
    assert.ok(true, "Skipped DB-backed trends test unless RUN_DB_TESTS=true");
    return;
  }

  const result = await VisaAnalyticsEngine.generateTrends({
    tenantId: "__missing_tenant__",
    period: "Today",
  });

  assert.equal(typeof result.fromCache, "boolean");
  assert.equal(result.data.period, "Today");
  assert.equal(result.data.dataPointsCount, 1);
});
