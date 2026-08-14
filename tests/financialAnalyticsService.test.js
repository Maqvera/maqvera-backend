import test from "node:test";
import assert from "node:assert/strict";
import FinancialAnalyticsService, {
  linearRegression,
  predictLinear,
  computeGrowthRate,
  classifyConfidence,
  computeFinancialRatios,
  applyScenarioAdjustment,
  computeZScoreAnomalies,
  detectDuplicatePayments,
  generateBuckets,
  parseForecastHorizon,
  computeEBITDA,
  computeCashBurnRate
} from "../services/FinancialAnalyticsService.js";

test("linearRegression fits a real perfect line exactly (r2 = 1) and predictLinear extrapolates it", () => {
  const regression = linearRegression([{ x: 0, y: 100 }, { x: 1, y: 110 }, { x: 2, y: 120 }]);
  assert.equal(regression.slope, 10);
  assert.equal(regression.intercept, 100);
  assert.equal(regression.r2, 1);
  assert.equal(predictLinear(regression, 3), 130);
});

test("linearRegression handles a single real data point without dividing by zero", () => {
  const regression = linearRegression([{ x: 0, y: 500 }]);
  assert.equal(regression.slope, 0);
  assert.equal(regression.intercept, 500);
});

test("linearRegression returns null for an empty series rather than fabricating a trend", () => {
  assert.equal(linearRegression([]), null);
});

test("computeGrowthRate is a real percent change, and null (not 0/Infinity) when there's nothing real to divide by", () => {
  assert.equal(computeGrowthRate(120, 100), 20);
  assert.equal(computeGrowthRate(80, 100), -20);
  assert.equal(computeGrowthRate(50, 0), null);
});

test("classifyConfidence is derived from real historical data-point count against configured thresholds", () => {
  const config = { analyticsConfidenceMediumDataPoints: 6, analyticsConfidenceHighDataPoints: 12 };
  assert.equal(classifyConfidence(2, config), "Low");
  assert.equal(classifyConfidence(6, config), "Medium");
  assert.equal(classifyConfidence(12, config), "High");
});

test("computeFinancialRatios collapses Gross Margin into Net Margin and Quick Ratio into Current Ratio honestly (no COGS/Current-Non-Current concept exists)", () => {
  const ratios = computeFinancialRatios({ totalAssets: 1000, totalLiabilities: 400, totalEquity: 600, totalRevenue: 500, netIncome: 100 });
  assert.equal(ratios.grossMargin, ratios.netMargin);
  assert.equal(ratios.netMargin, 20);
  assert.equal(ratios.currentRatio, ratios.quickRatio);
  assert.equal(ratios.currentRatio, 2.5);
  assert.equal(ratios.debtToEquity, 0.67);
  assert.equal(ratios.returnOnAssets, 10);
  assert.equal(ratios.returnOnEquity, 16.67);
});

test("computeFinancialRatios collapses Operating Margin into Net Margin and Operating Ratio into (100 - Net Margin) honestly (no Operating/Non-Operating account split exists)", () => {
  const ratios = computeFinancialRatios({ totalAssets: 1000, totalLiabilities: 400, totalEquity: 600, totalRevenue: 500, netIncome: 100 });
  assert.equal(ratios.operatingMargin, ratios.netMargin);
  assert.equal(ratios.operatingRatio, 80);
});

test("computeEBITDA equals real Net Income when no add-back account codes are configured, never fabricating a distinct figure", () => {
  assert.equal(computeEBITDA(1000, {}), 1000);
  assert.equal(computeEBITDA(1000), 1000);
});

test("computeEBITDA adds back only the real, configured interest/tax/depreciation/amortization amounts", () => {
  assert.equal(computeEBITDA(1000, { interest: 50, tax: 100, depreciation: 200, amortization: 20 }), 1370);
  assert.equal(computeEBITDA(1000, { depreciation: 200 }), 1200);
});

test("computeCashBurnRate is 0 when no real historical bucket was ever negative, not a fabricated projection", () => {
  assert.equal(computeCashBurnRate([{ value: 100 }, { value: 200 }]), 0);
  assert.equal(computeCashBurnRate([]), 0);
});

test("computeCashBurnRate averages only the real negative buckets in a cash-flow series", () => {
  assert.equal(computeCashBurnRate([{ value: 100 }, { value: -200 }, { value: -300 }]), 250);
});

test("computeFinancialRatios returns null (not a divide-by-zero artifact) when a real denominator is zero", () => {
  const ratios = computeFinancialRatios({ totalAssets: 0, totalLiabilities: 0, totalEquity: 0, totalRevenue: 0, netIncome: 0 });
  assert.equal(ratios.netMargin, null);
  assert.equal(ratios.currentRatio, null);
  assert.equal(ratios.debtToEquity, null);
});

test("applyScenarioAdjustment applies real deterministic what-if multipliers to a real baseline", () => {
  const applied = applyScenarioAdjustment({ revenue: 1000, expense: 600 }, { priceChangePercent: 5, costChangePercent: -5, demandChangePercent: 10 });
  assert.equal(applied.adjustedRevenue, 1155); // 1000 * 1.05 * 1.10
  assert.equal(applied.adjustedExpense, 627); // 600 * 0.95 * 1.10
  assert.equal(applied.adjustedNetIncome, 528);
});

test("computeZScoreAnomalies flags a real outlier beyond the threshold and stays silent under it", () => {
  const points = [{ label: "a", value: 100 }, { label: "b", value: 105 }, { label: "c", value: 95 }, { label: "d", value: 800 }];
  const flagged = computeZScoreAnomalies(points, 1.5);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].label, "d");
});

test("computeZScoreAnomalies returns no anomalies for fewer than 2 points or zero variance, never a fabricated flag", () => {
  assert.deepEqual(computeZScoreAnomalies([{ label: "a", value: 100 }], 2), []);
  assert.deepEqual(computeZScoreAnomalies([{ label: "a", value: 100 }, { label: "b", value: 100 }], 2), []);
});

test("detectDuplicatePayments flags same partyId+amount+currency within the real configured window, not outside it", () => {
  const payments = [
    { _id: "p1", partyId: "c1", amount: 100, currency: "USD", transactionDate: "2026-08-10T10:00:00Z" },
    { _id: "p2", partyId: "c1", amount: 100, currency: "USD", transactionDate: "2026-08-10T10:02:00Z" },
    { _id: "p3", partyId: "c1", amount: 100, currency: "USD", transactionDate: "2026-08-10T11:00:00Z" }
  ];
  const duplicates = detectDuplicatePayments(payments, 5);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].paymentId, "p2");
});

test("generateBuckets produces real, correctly-labeled Monthly/Quarterly/Yearly boundaries ending at the given date", () => {
  const monthly = generateBuckets("Monthly", 3, new Date("2026-08-10"));
  assert.deepEqual(monthly.map((b) => b.label), ["2026-06", "2026-07", "2026-08"]);
  assert.equal(monthly[monthly.length - 1].end.getTime() <= new Date("2026-08-10").getTime(), true);

  const quarterly = generateBuckets("Quarterly", 2, new Date("2026-08-10"));
  assert.deepEqual(quarterly.map((b) => b.label), ["2026-Q2", "2026-Q3"]);

  const yearly = generateBuckets("Yearly", 2, new Date("2026-08-10"));
  assert.deepEqual(yearly.map((b) => b.label), ["2025", "2026"]);
});

test("parseForecastHorizon recognizes real forward-looking horizon strings and falls back to the configured default otherwise", () => {
  const config = { analyticsForecastHorizonBuckets: 3 };
  assert.deepEqual(parseForecastHorizon("Next6Months", config), { granularity: "Monthly", count: 6 });
  assert.deepEqual(parseForecastHorizon("Next90Days", config), { granularity: "Weekly", count: 13 });
  assert.deepEqual(parseForecastHorizon("Quarterly", config), { granularity: "Quarterly", count: 3 });
  assert.deepEqual(parseForecastHorizon("garbage", config), { granularity: "Monthly", count: 3 });
  assert.deepEqual(parseForecastHorizon(null, config), { granularity: "Monthly", count: 3 });
});

test("FinancialAnalyticsService._buildExecutiveDashboards generates CEO, CFO, Finance, Department, and Board executive dashboards", () => {
  const sampleData = {
    financialMetrics: { revenue: 10000, expenses: 6000, grossProfit: 4000, netProfit: 4000, operatingMargin: 40, cashPosition: 25000, accountsReceivable: 5000, accountsPayable: 3000, workingCapital: 12000, ebitda: 4500 },
    financialKPIs: { revenueGrowth: 15, grossMargin: 40, netMargin: 40, ebitdaMargin: 45, operatingRatio: 60, workingCapital: 12000, currentRatio: 2.5, quickRatio: 2.5, debtToEquity: 0.5, returnOnAssets: 10, returnOnEquity: 15 },
    profitabilityAnalysis: { companyProfitability: {}, departmentProfitability: [{ departmentName: "Engineering", expenses: 3000 }], customerProfitability: [{ customerName: "Acme Corp", revenue: 5000 }], productProfitability: [], serviceProfitability: [], projectProfitability: [] },
    expenseAnalytics: { departmentExpenses: [{ departmentName: "Engineering", amount: 3000 }], categoryBreakdown: [{ category: "Payroll", amount: 4000 }] },
    revenueAnalytics: { revenueByCustomer: [{ customerName: "Acme Corp", revenue: 5000 }], revenueByProduct: [], revenueByService: [], revenueByCountry: [], revenueBySalesperson: [], recurringRevenue: 2000 },
    cashFlowAnalytics: { operatingCashFlow: 4000, cashBurnRate: 0, liquidityTrends: [], cashForecast: [] },
    trendAnalysis: { monthlyTrends: [], forecastTrends: [] }
  };

  const dashboards = FinancialAnalyticsService._buildExecutiveDashboards(sampleData);
  assert.ok(dashboards.ceoDashboard);
  assert.equal(dashboards.ceoDashboard.summary.totalRevenue, 10000);
  assert.ok(dashboards.cfoDashboard);
  assert.equal(dashboards.cfoDashboard.summary.ebitda, 4500);
  assert.ok(dashboards.financeDashboard);
  assert.equal(dashboards.financeDashboard.summary.accountsReceivable, 5000);
  assert.ok(dashboards.departmentDashboard);
  assert.equal(dashboards.departmentDashboard.departments.length, 1);
  assert.ok(dashboards.boardDashboard);
  assert.equal(dashboards.boardDashboard.summary.revenue, 10000);
});
