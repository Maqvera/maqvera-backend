import test from "node:test";
import assert from "node:assert/strict";
import KPIEngine from "../services/KPIEngine.js";

const baseMetrics = () => ({
  cashToday: 100000,
  todaysExpenses: 1000,
  todaysRevenue: 5000,
  overdueReceivables: 0,
  netCashFlowToday: 4000,
});

const baseArgs = (overrides = {}) => ({
  metrics: { ...baseMetrics(), ...(overrides.metrics || {}) },
  largePayments: overrides.largePayments || [],
  taxReports: overrides.taxReports || [],
  overduePayableRecords: overrides.overduePayableRecords || [],
  exceededBudgets: overrides.exceededBudgets || [],
  config: {
    lowCashThreshold: 0,
    highExpenseDailyThreshold: 0,
    largePaymentThreshold: 0,
    taxDueThreshold: 0,
    ...(overrides.config || {}),
  },
});

test("buildFinanceAlerts raises no alerts when every threshold is disabled and metrics are healthy", () => {
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs());
  assert.deepEqual(alerts, []);
});

test("buildFinanceAlerts raises LowCash only when a real threshold is configured and crossed", () => {
  const belowThreshold = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { cashToday: 500 }, config: { lowCashThreshold: 1000 } }));
  assert.equal(belowThreshold.some((a) => a.alertType === "LowCash"), true);

  const disabled = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { cashToday: 500 }, config: { lowCashThreshold: 0 } }));
  assert.equal(disabled.some((a) => a.alertType === "LowCash"), false);

  const aboveThreshold = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { cashToday: 5000 }, config: { lowCashThreshold: 1000 } }));
  assert.equal(aboveThreshold.some((a) => a.alertType === "LowCash"), false);
});

test("buildFinanceAlerts raises HighExpenses only when today's real expenses exceed the configured threshold", () => {
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { todaysExpenses: 9000 }, config: { highExpenseDailyThreshold: 5000 } }));
  assert.equal(alerts.some((a) => a.alertType === "HighExpenses" && a.value === 9000), true);
});

test("buildFinanceAlerts raises one LargePayment alert per qualifying real payment record", () => {
  const largePayments = [
    { _id: "p1", paymentNumber: "PMT-1", amount: 60000 },
    { _id: "p2", paymentNumber: "PMT-2", amount: 75000 },
  ];
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs({ largePayments, config: { largePaymentThreshold: 50000 } }));
  const largePaymentAlerts = alerts.filter((a) => a.alertType === "LargePayment");
  assert.equal(largePaymentAlerts.length, 2);
  assert.equal(largePaymentAlerts[0].sourceId, "p1");
});

test("buildFinanceAlerts raises OverdueReceivable using the real overdue count, not a guess", () => {
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { overdueReceivables: 37 } }));
  const alert = alerts.find((a) => a.alertType === "OverdueReceivable");
  assert.ok(alert);
  assert.equal(alert.value, 37);
});

test("buildFinanceAlerts raises one OverduePayable alert per real overdue payable record", () => {
  const overduePayableRecords = [{ _id: "ap1", invoiceNumber: "AP-1", vendorName: "Vendor A", outstandingBalance: 200 }];
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs({ overduePayableRecords }));
  assert.equal(alerts.filter((a) => a.alertType === "OverduePayable").length, 1);
});

test("buildFinanceAlerts raises BudgetExceeded per real over-consumed budget", () => {
  const exceededBudgets = [{ _id: "b1", scope: "Department", period: "2026-08", allocatedAmount: 1000, consumedAmount: 1500 }];
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs({ exceededBudgets }));
  const alert = alerts.find((a) => a.alertType === "BudgetExceeded");
  assert.equal(alert.value, 1500);
  assert.equal(alert.threshold, 1000);
});

test("buildFinanceAlerts raises NegativeCashFlow only when today's real net cash flow is negative", () => {
  const negative = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { netCashFlowToday: -500 } }));
  assert.equal(negative.some((a) => a.alertType === "NegativeCashFlow"), true);

  const positive = KPIEngine.buildFinanceAlerts(baseArgs({ metrics: { netCashFlowToday: 500 } }));
  assert.equal(positive.some((a) => a.alertType === "NegativeCashFlow"), false);
});

test("buildFinanceAlerts raises TaxDue per real generated tax report at/above the configured threshold", () => {
  const taxReports = [{ _id: "t1", reportType: "VAT", totalNetPayable: 12000 }];
  const alerts = KPIEngine.buildFinanceAlerts(baseArgs({ taxReports, config: { taxDueThreshold: 10000 } }));
  const alert = alerts.find((a) => a.alertType === "TaxDue");
  assert.equal(alert.value, 12000);
  assert.equal(alert.sourceId, "t1");
});
