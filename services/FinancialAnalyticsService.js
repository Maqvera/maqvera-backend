import FinancialAnalyticsModel from "../models/FinancialAnalyticsModel.js";
import FinancialReportService, { groupRowsForBalanceSheet, groupRowsForProfitAndLoss, summarizeCashFlow, computeBudgetVariance, AR_TERMINAL_STATUSES } from "./FinancialReportService.js";
import LedgerService from "./LedgerService.js";
import BankTransactionModel from "../models/BankTransactionModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import ExpenseModel from "../models/ExpenseModel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import ExpenseBudgetModel from "../models/ExpenseBudgetModel.js";
import PaymentModel from "../models/PaymentModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import { isPayableTerminal } from "./AccountsPayableService.js";
import DashboardAlertModel from "../models/DashboardAlertModel.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Real, committed expense states only — mirrors AR_TERMINAL_STATUSES/
// isPayableTerminal's own "only count what's real" discipline. Draft/
// Submitted/Under Review/Rejected/Cancelled/Returned expenses aren't yet
// (or never became) a real committed cost.
const EXPENSE_COMMITTED_STATUSES = new Set(["Approved", "Reimbursed", "Closed"]);

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/financialAnalyticsService.test.js).
// ---------------------------------------------------------------------------

/** Real ordinary-least-squares linear regression over [{x,y}] — the actual statistical basis for every Trend/Forecast analysis type. No ML model, no fabricated curve — see this module's own Deferred notes for why. */
export const linearRegression = (points) => {
  const n = points.length;
  if (n === 0) return null;
  if (n === 1) return { slope: 0, intercept: points[0].y, r2: 0 };
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - meanX) * (p.y - meanY); den += (p.x - meanX) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  let ssTot = 0, ssRes = 0;
  for (const p of points) { const pred = slope * p.x + intercept; ssRes += (p.y - pred) ** 2; ssTot += (p.y - meanY) ** 2; }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2: roundCurrency(r2) };
};

export const predictLinear = (regression, x) => (regression ? roundCurrency(regression.slope * x + regression.intercept) : null);

/** "Revenue Growth." Real percent change; null (not 0 or Infinity) when there's nothing real to divide by. */
export const computeGrowthRate = (current, previous) => {
  if (!previous) return null;
  return roundCurrency(((current - previous) / Math.abs(previous)) * 100);
};

/** "Confidence Level" — derived from real historical data-point count, never a fabricated precision claim. */
export const classifyConfidence = (dataPointCount, config) => {
  if (dataPointCount < config.analyticsConfidenceMediumDataPoints) return "Low";
  if (dataPointCount < config.analyticsConfidenceHighDataPoints) return "Medium";
  return "High";
};

/** "Financial Ratios." Gross Margin collapses to Net Margin and Quick Ratio collapses to Current Ratio — no inventory/COGS concept and no Current/Non-Current account subtype exist anywhere in this codebase's Chart of Accounts (same honest collapse already documented in Part 25's own KPIEngine), so these are never fabricated as separately-derived figures. */
export const computeFinancialRatios = ({ totalAssets, totalLiabilities, totalEquity, totalRevenue, netIncome }) => {
  const netMargin = totalRevenue ? roundCurrency((netIncome / totalRevenue) * 100) : null;
  const grossMargin = netMargin;
  // "Operating Margin"/"Operating Ratio" — Financial Analytics Platform
  // Enhancements (Part 29). No Operating vs Non-Operating account split
  // exists anywhere in this Chart of Accounts (only Assets/Liabilities/
  // Equity/Revenue/Expense), so these honestly collapse to the same real
  // Net Margin/Expense-Ratio figures already computed here — the same
  // documented-collapse discipline as grossMargin=netMargin above and
  // currentRatio=quickRatio below, not a fabricated distinct calculation.
  const operatingMargin = netMargin;
  const operatingRatio = totalRevenue ? roundCurrency(100 - netMargin) : null;
  const currentRatio = totalLiabilities ? roundCurrency(totalAssets / totalLiabilities) : null;
  const quickRatio = currentRatio;
  const debtToEquity = totalEquity ? roundCurrency(totalLiabilities / totalEquity) : null;
  const returnOnAssets = totalAssets ? roundCurrency((netIncome / totalAssets) * 100) : null;
  const returnOnEquity = totalEquity ? roundCurrency((netIncome / totalEquity) * 100) : null;
  return { grossMargin, netMargin, operatingMargin, operatingRatio, currentRatio, quickRatio, debtToEquity, returnOnAssets, returnOnEquity };
};

/** "EBITDA" — Earnings Before Interest, Taxes, Depreciation, and Amortization. Real add-backs only for whatever a tenant has actually configured (see utils/financeConfig.js's own doc comment) — 0 for anything unset, never fabricated. */
export const computeEBITDA = (netIncome, addBacks = {}) => {
  const { interest = 0, tax = 0, depreciation = 0, amortization = 0 } = addBacks;
  return roundCurrency((netIncome || 0) + interest + tax + depreciation + amortization);
};

/** "Cash Burn Rate" — the real average monthly net cash outflow across whichever historical buckets were actually negative in a real cash-flow series. 0 (not negative-infinity or a fabricated projection) when no bucket was ever negative. */
export const computeCashBurnRate = (series) => {
  const negativeBuckets = series.filter((s) => s.value < 0);
  if (negativeBuckets.length === 0) return 0;
  return roundCurrency(Math.abs(negativeBuckets.reduce((sum, s) => sum + s.value, 0) / negativeBuckets.length));
};

/** "Scenario Planning... Price Changes, Cost Changes, Exchange Rate Changes, Demand Changes." Real deterministic what-if multipliers applied to a real baseline (never a fabricated alternate baseline). */
export const applyScenarioAdjustment = (baseline, adjustment = {}) => {
  const { priceChangePercent = 0, costChangePercent = 0, exchangeRateChangePercent = 0, demandChangePercent = 0 } = adjustment;
  const demandMultiplier = 1 + demandChangePercent / 100;
  const priceMultiplier = 1 + priceChangePercent / 100;
  const fxMultiplier = 1 + exchangeRateChangePercent / 100;
  const costMultiplier = 1 + costChangePercent / 100;
  const adjustedRevenue = roundCurrency(baseline.revenue * priceMultiplier * demandMultiplier * fxMultiplier);
  const adjustedExpense = roundCurrency(baseline.expense * costMultiplier * demandMultiplier);
  return { adjustedRevenue, adjustedExpense, adjustedNetIncome: roundCurrency(adjustedRevenue - adjustedExpense), adjustment: { priceChangePercent, costChangePercent, exchangeRateChangePercent, demandChangePercent } };
};

/** "Anomaly Detection... Threshold Rules." Real z-score over a real series — the spec's own "Machine Learning Models" is explicitly NOT built (see this Part's own Deferred section, same honesty already applied to Part 25's "no ML" Tax Due alert). */
export const computeZScoreAnomalies = (points, stdDevThreshold) => {
  if (points.length < 2) return [];
  const values = points.map((p) => p.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return [];
  return points
    .map((p) => ({ ...p, zScore: roundCurrency((p.value - mean) / stdDev) }))
    .filter((p) => Math.abs(p.zScore) >= stdDevThreshold);
};

/** "Duplicate Payments" anomaly — same partyId+amount+currency within the real, already-configured fraud window (Part 7's own fraudDuplicateWindowMinutes), not a second, parallel window. */
export const detectDuplicatePayments = (payments, windowMinutes) => {
  const groups = new Map();
  for (const p of payments) {
    const key = `${p.partyId || "none"}|${p.amount}|${p.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const duplicates = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => new Date(a.transactionDate) - new Date(b.transactionDate));
    for (let i = 1; i < sorted.length; i += 1) {
      const minutesApart = (new Date(sorted[i].transactionDate) - new Date(sorted[i - 1].transactionDate)) / 60000;
      if (minutesApart <= windowMinutes) duplicates.push({ paymentId: sorted[i]._id, comparedToPaymentId: sorted[i - 1]._id, amount: sorted[i].amount, currency: sorted[i].currency, minutesApart: roundCurrency(minutesApart) });
    }
  }
  return duplicates;
};

/** Real calendar bucket boundaries (Weekly/Monthly/Quarterly/Yearly), oldest-first, ending at `endDate` — the shared basis every Trend/Forecast analysis buckets real GL/bank data into. */
export const generateBuckets = (granularity, count, endDate = new Date()) => {
  const buckets = [];
  const end = new Date(endDate);
  for (let i = count - 1; i >= 0; i -= 1) {
    let bucketStart, bucketEnd, label;
    if (granularity === "Weekly") {
      bucketEnd = new Date(end); bucketEnd.setUTCDate(bucketEnd.getUTCDate() - i * 7);
      bucketStart = new Date(bucketEnd); bucketStart.setUTCDate(bucketStart.getUTCDate() - 6);
      label = `${bucketStart.toISOString().slice(0, 10)}..${bucketEnd.toISOString().slice(0, 10)}`;
    } else if (granularity === "Quarterly") {
      const base = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i * 3, 1));
      const quarter = Math.floor(base.getUTCMonth() / 3);
      bucketStart = new Date(Date.UTC(base.getUTCFullYear(), quarter * 3, 1));
      bucketEnd = new Date(Date.UTC(base.getUTCFullYear(), quarter * 3 + 3, 0, 23, 59, 59, 999));
      label = `${bucketStart.getUTCFullYear()}-Q${quarter + 1}`;
    } else if (granularity === "Yearly") {
      const year = end.getUTCFullYear() - i;
      bucketStart = new Date(Date.UTC(year, 0, 1));
      bucketEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
      label = `${year}`;
    } else {
      const base = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
      bucketStart = base;
      bucketEnd = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59, 999));
      label = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
    }
    buckets.push({ label, start: bucketStart, end: bucketEnd > end ? end : bucketEnd });
  }
  return buckets;
};

/** Parses a forward-looking horizon like "Next12Months"/"Next90Days"/"Weekly"/"Monthly"/"Quarterly"/"Yearly" into a real {granularity, count} — falls back to the configured default horizon rather than guessing at an unrecognized string. */
export const parseForecastHorizon = (period, config) => {
  if (!period) return { granularity: "Monthly", count: config.analyticsForecastHorizonBuckets };
  const trimmed = `${period}`.trim();
  if (["Weekly", "Monthly", "Quarterly", "Yearly"].includes(trimmed)) return { granularity: trimmed, count: config.analyticsForecastHorizonBuckets };
  const nextMonths = trimmed.match(/^Next(\d+)Months?$/i);
  if (nextMonths) return { granularity: "Monthly", count: parseInt(nextMonths[1], 10) };
  const nextDays = trimmed.match(/^Next(\d+)Days?$/i);
  if (nextDays) return { granularity: "Weekly", count: Math.max(1, Math.round(parseInt(nextDays[1], 10) / 7)) };
  const nextYears = trimmed.match(/^Next(\d+)Years?$/i);
  if (nextYears) return { granularity: "Yearly", count: parseInt(nextYears[1], 10) };
  const nextQuarters = trimmed.match(/^Next(\d+)Quarters?$/i);
  if (nextQuarters) return { granularity: "Quarterly", count: parseInt(nextQuarters[1], 10) };
  return { granularity: "Monthly", count: config.analyticsForecastHorizonBuckets };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class FinancialAnalyticsService {
  static async _seriesFromLedgerMovement(tenantId, buckets, currency, categories) {
    const series = [];
    for (const bucket of buckets) {
      const rows = await FinancialReportService.getPeriodMovement(tenantId, bucket.start, bucket.end, currency, categories);
      series.push({ label: bucket.label, start: bucket.start, end: bucket.end, value: roundCurrency(rows.reduce((s, r) => s + r.netBalance, 0)) });
    }
    return series;
  }

  static async _seriesFromCashFlow(tenantId, buckets, currency, bankAccountId) {
    const series = [];
    for (const bucket of buckets) {
      const filter = { tenantId, createdAt: { $gte: bucket.start, $lte: bucket.end } };
      if (currency) filter.currency = currency;
      if (bankAccountId) filter.bankAccountId = bankAccountId;
      const transactions = await BankTransactionModel.find(filter).select("type direction amount currency").lean();
      series.push({ label: bucket.label, start: bucket.start, end: bucket.end, value: summarizeCashFlow(transactions).netCashFlow });
    }
    return series;
  }

  static async _seriesFromTrialBalance(tenantId, buckets, currency) {
    const series = [];
    for (const bucket of buckets) {
      const trialBalance = await LedgerService.getTrialBalance({ currency, date: bucket.end }, tenantId);
      const { totalAssets, totalLiabilities, totalEquity } = groupRowsForBalanceSheet(trialBalance.rows);
      series.push({ label: bucket.label, start: bucket.start, end: bucket.end, totalAssets, totalLiabilities, totalEquity, value: roundCurrency(totalAssets - totalLiabilities) });
    }
    return series;
  }

  /** Real EBITDA add-back lookups — one real GL query per configured account code, 0 (not a query) for anything left unset. See computeEBITDA/utils/financeConfig.js's own doc comment. */
  static async _computeEbitdaAddBacks(tenantId, start, end) {
    const config = getFinanceConfig();
    const [interest, tax, depreciation, amortization] = await Promise.all([
      FinancialReportService.getAccountCodeMovement(tenantId, config.interestExpenseAccountCode, start, end),
      FinancialReportService.getAccountCodeMovement(tenantId, config.incomeTaxExpenseAccountCode, start, end),
      FinancialReportService.getAccountCodeMovement(tenantId, config.depreciationExpenseAccountCode, start, end),
      FinancialReportService.getAccountCodeMovement(tenantId, config.amortizationExpenseAccountCode, start, end)
    ]);
    return {
      interest, tax, depreciation, amortization,
      configured: { interest: !!config.interestExpenseAccountCode, tax: !!config.incomeTaxExpenseAccountCode, depreciation: !!config.depreciationExpenseAccountCode, amortization: !!config.amortizationExpenseAccountCode }
    };
  }

  static _forecastFromSeries(series, horizonCount, config) {
    const points = series.map((s, i) => ({ x: i, y: s.value }));
    const regression = linearRegression(points);
    const confidenceLevel = classifyConfidence(series.length, config);
    const insufficientData = series.length < config.analyticsMinDataPointsForTrend;
    const forecasts = [];
    if (!insufficientData && regression) {
      for (let i = 1; i <= horizonCount; i += 1) forecasts.push({ bucketOffset: i, predictedValue: predictLinear(regression, points.length - 1 + i) });
    }
    return { forecasts, confidenceLevel, insufficientData };
  }

  static async _generateExecutiveInsights(tenantId, currency) {
    const buckets = generateBuckets("Monthly", 6);
    const [revenueSeries, expenseSeries, activeAlerts] = await Promise.all([
      FinancialAnalyticsService._seriesFromLedgerMovement(tenantId, buckets, currency, ["Revenue"]),
      FinancialAnalyticsService._seriesFromLedgerMovement(tenantId, buckets, currency, ["Expense"]),
      DashboardAlertModel.find({ tenantId, status: "Active" }).select("alertType severity message value threshold").limit(20).lean()
    ]);
    const periodStart = buckets[0].start;
    const periodEnd = buckets[buckets.length - 1].end;
    const combinedSeries = [...revenueSeries.map((s) => ({ ...s, metric: "Revenue" })), ...expenseSeries.map((s) => ({ ...s, metric: "Expense" }))];

    const systemPrompt = "You are a financial analytics assistant for an ERP's Executive Insights module. Given 6 months of real revenue/expense trend data and any currently active dashboard alerts, produce real, grounded observations — never invent figures not present in the input. Respond with ONLY JSON, no prose, in this exact shape: {\"keyDrivers\":[\"...\"],\"riskIndicators\":[\"...\"],\"growthOpportunities\":[\"...\"],\"costSavingOpportunities\":[\"...\"],\"cashRiskAlerts\":[\"...\"],\"narrativeSummary\":\"...\",\"recommendations\":[\"...\"]}. This is advisory only — nothing will be executed automatically.";
    const userPrompt = `Revenue (last 6 months): ${JSON.stringify(revenueSeries.map((s) => ({ month: s.label, value: s.value })))}\n\nExpense (last 6 months): ${JSON.stringify(expenseSeries.map((s) => ({ month: s.label, value: s.value })))}\n\nActive dashboard alerts: ${JSON.stringify(activeAlerts)}`;

    let llmResult;
    try {
      llmResult = await AIModelRouterService.route({ tenantId, category: "reasoning", messages: [{ role: "user", content: userPrompt }], tools: [], systemPrompt });
    } catch (error) {
      return { series: combinedSeries, kpis: { aiAvailable: false }, insights: [], recommendations: [], forecasts: [], confidenceLevel: "Low", periodStart, periodEnd, error: error.message };
    }

    let parsed;
    try {
      const jsonText = (llmResult.content || "{}").replace(/^```json\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(jsonText);
    } catch {
      return { series: combinedSeries, kpis: { aiAvailable: true }, insights: [], recommendations: [], forecasts: [], confidenceLevel: "Low", periodStart, periodEnd, error: "The AI did not return valid structured insights." };
    }

    const insights = [
      ...(Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers.map((text) => ({ category: "KeyDriver", text })) : []),
      ...(Array.isArray(parsed.riskIndicators) ? parsed.riskIndicators.map((text) => ({ category: "RiskIndicator", text })) : []),
      ...(Array.isArray(parsed.growthOpportunities) ? parsed.growthOpportunities.map((text) => ({ category: "GrowthOpportunity", text })) : []),
      ...(Array.isArray(parsed.costSavingOpportunities) ? parsed.costSavingOpportunities.map((text) => ({ category: "CostSavingOpportunity", text })) : []),
      ...(Array.isArray(parsed.cashRiskAlerts) ? parsed.cashRiskAlerts.map((text) => ({ category: "CashRiskAlert", text })) : []),
      ...(parsed.narrativeSummary ? [{ category: "NarrativeSummary", text: parsed.narrativeSummary }] : [])
    ];
    return { series: combinedSeries, kpis: { aiAvailable: true, provider: llmResult.provider, model: llmResult.model }, insights, recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [], forecasts: [], confidenceLevel: "Medium", periodStart, periodEnd };
  }

  /**
   * POST /api/v1/financial-analytics/run
   * Validate Parameters -> Load Historical Data -> Apply Analytics Model
   * -> Generate KPIs -> Generate Insights -> Store Analytics History ->
   * Publish AnalyticsCompleted. Dispatches by `analysisType` — every
   * branch reads from an already-real, already-immutable source (the
   * General Ledger via LedgerService/FinancialReportService, or a real
   * operational collection); none recalculates a business transaction.
   */
  static async runAnalysis(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { analysisType, period = null, periodStart = null, periodEnd = null, currency = null, ...params } = data;
    if (!config.analysisTypes.includes(analysisType)) throw new Error(`Invalid analysisType "${analysisType}".`);
    if (currency && !config.supportedCurrencies.includes(currency)) throw new Error(`Invalid currency "${currency}".`);

    publishEvent("AnalyticsRequested", { tenantId, analysisType, period, performedBy: userId || null });

    let result;

    switch (analysisType) {
      case "RevenueTrend":
      case "ExpenseTrend": {
        const category = analysisType === "RevenueTrend" ? "Revenue" : "Expense";
        const buckets = generateBuckets("Monthly", params.bucketsBack || config.analyticsTrendBucketsBack);
        const series = await FinancialAnalyticsService._seriesFromLedgerMovement(tenantId, buckets, currency, [category]);
        const growthRateMoM = series.length >= 2 ? computeGrowthRate(series[series.length - 1].value, series[series.length - 2].value) : null;
        const growthRateOverPeriod = series.length >= 2 ? computeGrowthRate(series[series.length - 1].value, series[0].value) : null;
        result = { series, kpis: { latestValue: series.length ? series[series.length - 1].value : 0, growthRateMoM, growthRateOverPeriod }, forecasts: [], confidenceLevel: classifyConfidence(series.length, config), periodStart: buckets[0].start, periodEnd: buckets[buckets.length - 1].end };
        break;
      }

      case "RevenueForecast":
      case "ExpenseForecast": {
        const category = analysisType === "RevenueForecast" ? "Revenue" : "Expense";
        const historyBuckets = generateBuckets("Monthly", params.bucketsBack || config.analyticsTrendBucketsBack);
        const series = await FinancialAnalyticsService._seriesFromLedgerMovement(tenantId, historyBuckets, currency, [category]);
        const horizon = parseForecastHorizon(period, config);
        const { forecasts, confidenceLevel, insufficientData } = FinancialAnalyticsService._forecastFromSeries(series, horizon.count, config);
        result = { series, forecasts, kpis: { insufficientData }, confidenceLevel, periodStart: historyBuckets[0].start, periodEnd: historyBuckets[historyBuckets.length - 1].end };
        break;
      }

      case "RevenueByCustomer": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const filter = { tenantId, issueDate: { $lte: end }, status: { $ne: "Draft" } };
        if (start) filter.issueDate.$gte = start;
        if (currency) filter.currency = currency;
        const invoices = await InvoiceModel.find(filter).select("customerId customerName grandTotal").lean();
        const byCustomer = new Map();
        for (const inv of invoices) {
          const key = inv.customerId.toString();
          if (!byCustomer.has(key)) byCustomer.set(key, { customerId: key, customerName: inv.customerName, total: 0, invoiceCount: 0 });
          const entry = byCustomer.get(key);
          entry.total = roundCurrency(entry.total + inv.grandTotal);
          entry.invoiceCount += 1;
        }
        const series = [...byCustomer.values()].sort((a, b) => b.total - a.total);
        result = { series, kpis: { totalRevenue: roundCurrency(series.reduce((s, c) => s + c.total, 0)), customerCount: series.length }, forecasts: [], confidenceLevel: classifyConfidence(series.length, config), periodStart: start, periodEnd: end };
        break;
      }

      case "RecurringRevenue": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const filter = { tenantId, invoiceType: "Recurring", issueDate: { $lte: end }, status: { $ne: "Draft" } };
        if (start) filter.issueDate.$gte = start;
        if (currency) filter.currency = currency;
        const invoices = await InvoiceModel.find(filter).select("grandTotal").lean();
        result = { series: [], kpis: { recurringRevenueTotal: roundCurrency(invoices.reduce((s, i) => s + i.grandTotal, 0)), recurringInvoiceCount: invoices.length }, forecasts: [], confidenceLevel: "High", periodStart: start, periodEnd: end };
        break;
      }

      case "ExpenseCategories":
      case "CostDrivers": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const filter = { tenantId, expenseDate: { $lte: end }, status: { $in: [...EXPENSE_COMMITTED_STATUSES] } };
        if (start) filter.expenseDate.$gte = start;
        if (currency) filter.currency = currency;
        const expenses = await ExpenseModel.find(filter).select("category amount").lean();
        const byCategory = new Map();
        for (const e of expenses) {
          if (!byCategory.has(e.category)) byCategory.set(e.category, { category: e.category, total: 0, count: 0 });
          const entry = byCategory.get(e.category);
          entry.total = roundCurrency(entry.total + e.amount);
          entry.count += 1;
        }
        let series = [...byCategory.values()].sort((a, b) => b.total - a.total);
        if (analysisType === "CostDrivers") series = series.slice(0, params.topN || 5);
        result = { series, kpis: { totalExpense: roundCurrency(series.reduce((s, c) => s + c.total, 0)) }, forecasts: [], confidenceLevel: classifyConfidence(series.length, config), periodStart: start, periodEnd: end };
        break;
      }

      case "DepartmentExpenses": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const filter = { tenantId, department: { $ne: null }, expenseDate: { $lte: end }, status: { $in: [...EXPENSE_COMMITTED_STATUSES] } };
        if (start) filter.expenseDate.$gte = start;
        if (currency) filter.currency = currency;
        const expenses = await ExpenseModel.find(filter).select("department amount").lean();
        const byDepartment = new Map();
        for (const e of expenses) {
          const key = e.department.toString();
          if (!byDepartment.has(key)) byDepartment.set(key, { departmentId: key, total: 0, count: 0 });
          const entry = byDepartment.get(key);
          entry.total = roundCurrency(entry.total + e.amount);
          entry.count += 1;
        }
        const departmentIds = [...byDepartment.keys()];
        const departments = departmentIds.length > 0 ? await DepartmentModel.find({ _id: { $in: departmentIds } }).select("name").lean() : [];
        const nameById = new Map(departments.map((d) => [d._id.toString(), d.name]));
        const series = [...byDepartment.values()].map((entry) => ({ ...entry, departmentName: nameById.get(entry.departmentId) || "Unknown" })).sort((a, b) => b.total - a.total);
        result = { series, kpis: { totalExpense: roundCurrency(series.reduce((s, d) => s + d.total, 0)), departmentCount: series.length }, forecasts: [], confidenceLevel: classifyConfidence(series.length, config), periodStart: start, periodEnd: end };
        break;
      }

      case "CashFlowForecast": {
        const horizon = parseForecastHorizon(period, config);
        const historyBuckets = generateBuckets(horizon.granularity, params.bucketsBack || config.analyticsTrendBucketsBack);
        const series = await FinancialAnalyticsService._seriesFromCashFlow(tenantId, historyBuckets, currency, params.bankAccountId);
        const { forecasts, confidenceLevel, insufficientData } = FinancialAnalyticsService._forecastFromSeries(series, horizon.count, config);

        const lastBucket = historyBuckets[historyBuckets.length - 1];
        const bucketSpanMs = lastBucket.end.getTime() - lastBucket.start.getTime();
        const projectedEnd = new Date(lastBucket.end.getTime() + bucketSpanMs * horizon.count);
        const [receivablesDue, payablesDue] = await Promise.all([
          AccountsReceivableModel.find({ tenantId, status: { $nin: [...AR_TERMINAL_STATUSES] }, dueDate: { $gte: lastBucket.end, $lte: projectedEnd }, ...(currency ? { currency } : {}) }).select("outstandingBalance").lean(),
          AccountsPayableModel.find({ tenantId, dueDate: { $gte: lastBucket.end, $lte: projectedEnd }, ...(currency ? { currency } : {}) }).select("outstandingBalance status").lean()
        ]);
        const expectedInflowFromAR = roundCurrency(receivablesDue.reduce((s, r) => s + r.outstandingBalance, 0));
        const expectedOutflowToAP = roundCurrency(payablesDue.filter((p) => !isPayableTerminal(p.status)).reduce((s, p) => s + p.outstandingBalance, 0));
        const averageBurnRate = computeCashBurnRate(series);

        result = { series, forecasts, kpis: { insufficientData, expectedInflowFromAR, expectedOutflowToAP, netNearTermAdjustment: roundCurrency(expectedInflowFromAR - expectedOutflowToAP), averageBurnRate }, confidenceLevel, periodStart: historyBuckets[0].start, periodEnd: lastBucket.end };
        break;
      }

      case "WorkingCapitalForecast": {
        const historyBuckets = generateBuckets("Monthly", params.bucketsBack || config.analyticsTrendBucketsBack);
        const series = await FinancialAnalyticsService._seriesFromTrialBalance(tenantId, historyBuckets, currency);
        const horizon = parseForecastHorizon(period, config);
        const { forecasts, confidenceLevel, insufficientData } = FinancialAnalyticsService._forecastFromSeries(series, horizon.count, config);
        result = { series, forecasts, kpis: { insufficientData, latestWorkingCapital: series.length ? series[series.length - 1].value : 0 }, confidenceLevel, periodStart: historyBuckets[0].start, periodEnd: historyBuckets[historyBuckets.length - 1].end };
        break;
      }

      case "FinancialRatios": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const [trialBalance, periodRows] = await Promise.all([
          LedgerService.getTrialBalance({ currency, date: end }, tenantId),
          FinancialReportService.getPeriodMovement(tenantId, start, end, currency, ["Revenue", "Expense"])
        ]);
        const { totalAssets, totalLiabilities, totalEquity } = groupRowsForBalanceSheet(trialBalance.rows);
        const { totalRevenue, totalExpense, netIncome } = groupRowsForProfitAndLoss(periodRows);
        const ratios = computeFinancialRatios({ totalAssets, totalLiabilities, totalEquity, totalRevenue, netIncome });
        const ebitdaAddBacks = await FinancialAnalyticsService._computeEbitdaAddBacks(tenantId, start, end);
        const ebitda = computeEBITDA(netIncome, ebitdaAddBacks);
        const ebitdaMargin = totalRevenue ? roundCurrency((ebitda / totalRevenue) * 100) : null;
        result = { series: [], kpis: { totalAssets, totalLiabilities, totalEquity, totalRevenue, totalExpense, netIncome, ...ratios, ebitda, ebitdaMargin, ebitdaAddBacks }, forecasts: [], confidenceLevel: "High", periodStart: start, periodEnd: end };
        break;
      }

      case "BudgetVsActual": {
        const budgets = await ExpenseBudgetModel.find({ tenantId, ...(params.scope ? { scope: params.scope } : {}), ...(params.period ? { period: params.period } : {}) }).lean();
        const series = budgets.map((b) => ({ scope: b.scope, scopeRef: b.scopeRef, period: b.period, currency: b.currency, allocatedAmount: b.allocatedAmount, actualAmount: b.consumedAmount, ...computeBudgetVariance(b.allocatedAmount, b.consumedAmount) }));
        result = { series, kpis: { totalAllocated: roundCurrency(series.reduce((s, l) => s + l.allocatedAmount, 0)), totalActual: roundCurrency(series.reduce((s, l) => s + l.actualAmount, 0)), overBudgetCount: series.filter((s) => s.isOverBudget).length }, forecasts: [], confidenceLevel: "High", periodStart: null, periodEnd: null };
        break;
      }

      case "CurrentVsPrevious": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        if (!start) throw new Error("period or periodStart is required for CurrentVsPrevious variance analysis.");
        const periodMs = end.getTime() - start.getTime();
        const previousEnd = new Date(start.getTime() - 1);
        const previousStart = new Date(previousEnd.getTime() - periodMs);
        const categories = params.categories || ["Revenue", "Expense"];
        const [currentRows, previousRows] = await Promise.all([
          FinancialReportService.getPeriodMovement(tenantId, start, end, currency, categories),
          FinancialReportService.getPeriodMovement(tenantId, previousStart, previousEnd, currency, categories)
        ]);
        const currentTotal = roundCurrency(currentRows.reduce((s, r) => s + r.netBalance, 0));
        const previousTotal = roundCurrency(previousRows.reduce((s, r) => s + r.netBalance, 0));
        result = { series: [{ label: "Previous", start: previousStart, end: previousEnd, value: previousTotal }, { label: "Current", start, end, value: currentTotal }], kpis: { currentTotal, previousTotal, growthRate: computeGrowthRate(currentTotal, previousTotal), ...computeBudgetVariance(previousTotal, currentTotal) }, forecasts: [], confidenceLevel: "High", periodStart: start, periodEnd: end };
        break;
      }

      case "ForecastVsActual": {
        if (!params.forecastAnalysisId) throw new Error("forecastAnalysisId is required for ForecastVsActual variance analysis.");
        const forecastRecord = await FinancialAnalyticsModel.findOne({ _id: params.forecastAnalysisId, tenantId }).lean();
        if (!forecastRecord) throw new Error("Referenced forecast analysis not found.");
        if (!["RevenueForecast", "ExpenseForecast"].includes(forecastRecord.analysisType)) throw new Error(`ForecastVsActual comparison is only supported against RevenueForecast/ExpenseForecast analyses (found "${forecastRecord.analysisType}").`);
        if (!forecastRecord.forecasts || forecastRecord.forecasts.length === 0) throw new Error("Referenced analysis has no forecasted buckets to compare.");

        const category = forecastRecord.analysisType === "ExpenseForecast" ? "Expense" : "Revenue";
        const comparisons = [];
        for (const forecast of forecastRecord.forecasts) {
          const bucketEnd = new Date(forecastRecord.periodEnd);
          bucketEnd.setUTCMonth(bucketEnd.getUTCMonth() + forecast.bucketOffset);
          if (bucketEnd > new Date()) continue; // Only compare buckets that have actually elapsed — real actuals, not a guess at the future.
          const bucketStart = new Date(bucketEnd);
          bucketStart.setUTCMonth(bucketStart.getUTCMonth() - 1);
          bucketStart.setUTCDate(bucketStart.getUTCDate() + 1);
          const rows = await FinancialReportService.getPeriodMovement(tenantId, bucketStart, bucketEnd, forecastRecord.currency, [category]);
          const actualValue = roundCurrency(rows.reduce((s, r) => s + r.netBalance, 0));
          comparisons.push({ bucketOffset: forecast.bucketOffset, bucketStart, bucketEnd, predictedValue: forecast.predictedValue, actualValue, ...computeBudgetVariance(forecast.predictedValue, actualValue) });
        }
        if (comparisons.length === 0) throw new Error("No forecasted buckets from the referenced analysis have elapsed yet — nothing real to compare against.");
        result = { series: comparisons, kpis: { comparedBucketCount: comparisons.length, averageAbsoluteVariancePercent: roundCurrency(comparisons.reduce((s, c) => s + Math.abs(c.variancePercent || 0), 0) / comparisons.length) }, forecasts: [], confidenceLevel: "High", periodStart: null, periodEnd: null };
        break;
      }

      case "ScenarioPlanning": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const periodRows = await FinancialReportService.getPeriodMovement(tenantId, start, end, currency, ["Revenue", "Expense"]);
        const { totalRevenue, totalExpense } = groupRowsForProfitAndLoss(periodRows);
        const scenario = params.scenario || "ExpectedCase";
        const presets = { BestCase: { priceChangePercent: 5, costChangePercent: -5, demandChangePercent: 10 }, WorstCase: { priceChangePercent: -5, costChangePercent: 10, demandChangePercent: -10 }, ExpectedCase: { priceChangePercent: 0, costChangePercent: 0, demandChangePercent: 0 } };
        const adjustment = scenario === "Custom" ? (params.adjustment || {}) : (presets[scenario] || presets.ExpectedCase);
        const applied = applyScenarioAdjustment({ revenue: totalRevenue, expense: totalExpense }, adjustment);
        result = { series: [], kpis: { scenario, baselineRevenue: totalRevenue, baselineExpense: totalExpense, baselineNetIncome: roundCurrency(totalRevenue - totalExpense), ...applied }, forecasts: [], confidenceLevel: "High", periodStart: start, periodEnd: end };
        publishEvent("ScenarioCalculated", { tenantId, scenario, performedBy: userId || null });
        break;
      }

      case "AnomalyDetection": {
        const bucketsBack = params.bucketsBack || config.analyticsTrendBucketsBack;
        const anomalyTypes = params.anomalyTypes && params.anomalyTypes.length > 0 ? params.anomalyTypes : ["RevenueSpike", "RevenueDrop", "ExpenseSpike", "DuplicatePayments"];
        const stdDevThreshold = params.stdDevThreshold || config.analyticsAnomalyStdDevThreshold;
        const anomalies = [];

        if (anomalyTypes.includes("RevenueSpike") || anomalyTypes.includes("RevenueDrop")) {
          const buckets = generateBuckets("Monthly", bucketsBack);
          const series = await FinancialAnalyticsService._seriesFromLedgerMovement(tenantId, buckets, currency, ["Revenue"]);
          const flagged = computeZScoreAnomalies(series.map((s) => ({ label: s.label, value: s.value })), stdDevThreshold);
          for (const f of flagged) anomalies.push({ anomalyType: f.zScore > 0 ? "RevenueSpike" : "RevenueDrop", label: f.label, value: f.value, zScore: f.zScore });
        }
        if (anomalyTypes.includes("ExpenseSpike")) {
          const buckets = generateBuckets("Monthly", bucketsBack);
          const series = await FinancialAnalyticsService._seriesFromLedgerMovement(tenantId, buckets, currency, ["Expense"]);
          const flagged = computeZScoreAnomalies(series.map((s) => ({ label: s.label, value: s.value })), stdDevThreshold).filter((f) => f.zScore > 0);
          for (const f of flagged) anomalies.push({ anomalyType: "ExpenseSpike", label: f.label, value: f.value, zScore: f.zScore });
        }
        if (anomalyTypes.includes("DuplicatePayments")) {
          const since = new Date(); since.setUTCDate(since.getUTCDate() - (params.lookbackDays || 30));
          const payments = await PaymentModel.find({ tenantId, status: { $in: ["Captured", "Allocated", "Settled", "Completed"] }, transactionDate: { $gte: since } }).select("partyId amount currency transactionDate").lean();
          for (const d of detectDuplicatePayments(payments, config.fraudDuplicateWindowMinutes)) anomalies.push({ anomalyType: "DuplicatePayments", ...d });
        }
        if (anomalyTypes.includes("AbnormalTransactions")) {
          const since = new Date(); since.setUTCDate(since.getUTCDate() - (params.lookbackDays || 30));
          const payments = await PaymentModel.find({ tenantId, status: { $in: ["Captured", "Allocated", "Settled", "Completed"] }, transactionDate: { $gte: since } }).select("_id amount paymentNumber").lean();
          const flagged = computeZScoreAnomalies(payments.map((p) => ({ label: p.paymentNumber, value: p.amount, paymentId: p._id })), stdDevThreshold);
          for (const f of flagged) anomalies.push({ anomalyType: "AbnormalTransactions", paymentNumber: f.label, amount: f.value, zScore: f.zScore, paymentId: f.paymentId });
        }
        if (anomalyTypes.includes("CashShortage") && config.lowCashThreshold > 0) {
          const buckets = generateBuckets("Monthly", bucketsBack);
          const cashSeries = await FinancialAnalyticsService._seriesFromCashFlow(tenantId, buckets, currency);
          const { forecasts } = FinancialAnalyticsService._forecastFromSeries(cashSeries, 3, config);
          for (const f of forecasts) if (f.predictedValue < config.lowCashThreshold) anomalies.push({ anomalyType: "CashShortage", bucketOffset: f.bucketOffset, predictedValue: f.predictedValue, threshold: config.lowCashThreshold });
        }

        result = { series: [], kpis: { anomalyCount: anomalies.length }, forecasts: anomalies, confidenceLevel: "Medium", periodStart: null, periodEnd: null };
        if (anomalies.length > 0) publishEvent("AnomalyDetected", { tenantId, anomalyCount: anomalies.length, performedBy: userId || null });
        break;
      }

      case "ExecutiveInsights": {
        result = await FinancialAnalyticsService._generateExecutiveInsights(tenantId, currency);
        break;
      }

      case "Custom": {
        const { start, end } = await FinancialReportService.resolvePeriodRange(period, periodStart, periodEnd);
        const rows = await FinancialReportService.getPeriodMovement(tenantId, start, end, currency, params.categories || ["Revenue", "Expense"]);
        const filteredRows = params.accountCodes?.length > 0 ? rows.filter((r) => params.accountCodes.includes(r.accountCode)) : rows;
        result = { series: filteredRows, kpis: { total: roundCurrency(filteredRows.reduce((s, r) => s + r.netBalance, 0)) }, forecasts: [], confidenceLevel: "High", periodStart: start, periodEnd: end };
        break;
      }

      default:
        throw new Error(`Analysis type "${analysisType}" is not yet supported.`);
    }

    const analysis = await FinancialAnalyticsModel.create({
      tenantId, analysisType, period, periodStart: result.periodStart || null, periodEnd: result.periodEnd || null, currency,
      parameters: { period, periodStart, periodEnd, currency, ...params }, kpis: result.kpis || {}, series: result.series || [],
      forecasts: result.forecasts || [], insights: result.insights || [], recommendations: result.recommendations || [],
      confidenceLevel: result.confidenceLevel || null, status: config.defaultAnalyticsStatus, error: result.error || null,
      requestedBy: userId || null, generatedAt: new Date(),
      expiresAt: config.analyticsRetentionDays > 0 ? new Date(Date.now() + config.analyticsRetentionDays * 24 * 60 * 60 * 1000) : null,
      timeline: [{ event: "AnalyticsCompleted", description: `${analysisType} analysis completed${period ? ` for ${period}` : ""}.`, performedBy: userId || null }]
    });

    await AuditLogModel.create({ action: "finance.analytics.run", module: "Finance", resource: "FinancialAnalytics", resourceId: analysis._id.toString(), userId: userId || null, tenantId, details: { analysisType, period } });
    publishEvent("AnalyticsCompleted", { tenantId, analysisId: analysis._id.toString(), analysisType, period, performedBy: userId || null });
    if (["RevenueForecast", "ExpenseForecast", "CashFlowForecast", "WorkingCapitalForecast"].includes(analysisType)) publishEvent("ForecastGenerated", { tenantId, analysisId: analysis._id.toString(), analysisType, performedBy: userId || null });
    if (analysis.recommendations.length > 0) publishEvent("RecommendationPublished", { tenantId, analysisId: analysis._id.toString(), analysisType, performedBy: userId || null });
    if (analysisType === "ExecutiveInsights" && analysis.insights.length > 0) publishEvent("InsightGenerated", { tenantId, analysisId: analysis._id.toString(), performedBy: userId || null });

    return analysis.toJSON();
  }

  static async listAnalytics(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.analysisType) filter.analysisType = query.analysisType;
    if (query.status) filter.status = query.status;
    if (query.currency) filter.currency = query.currency;
    if (query.period) filter.period = query.period;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { generatedAt: -1 };
    if (query.sort) {
      const direction = query.sort.startsWith("-") ? -1 : 1;
      sortSpec = { [query.sort.replace(/^-/, "")]: direction };
    }

    const [items, total] = await Promise.all([
      FinancialAnalyticsModel.find(filter).select("-series -forecasts -insights").sort(sortSpec).skip(skip).limit(pageSize).lean(),
      FinancialAnalyticsModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getAnalyticsById(analysisId, tenantId) {
    const analysis = await FinancialAnalyticsModel.findOne({ _id: analysisId, tenantId }).lean();
    if (!analysis) throw new Error("Financial analysis not found.");
    return analysis;
  }

  static async cancelAnalysis(analysisId, tenantId, userId) {
    const analysis = await FinancialAnalyticsModel.findOne({ _id: analysisId, tenantId });
    if (!analysis) throw new Error("Financial analysis not found.");
    if (analysis.status !== "Completed") throw new Error(`Analysis cannot be cancelled from status "${analysis.status}".`);
    analysis.status = "Cancelled";
    analysis.timeline.push({ event: "AnalyticsCancelled", description: "Analysis cancelled.", performedBy: userId || null });
    await analysis.save();
    return analysis.toJSON();
  }

  static async archiveAnalysis(analysisId, tenantId, userId) {
    const analysis = await FinancialAnalyticsModel.findOne({ _id: analysisId, tenantId });
    if (!analysis) throw new Error("Financial analysis not found.");
    if (analysis.status !== "Completed") throw new Error(`Analysis cannot be archived from status "${analysis.status}".`);
    analysis.status = "Archived";
    analysis.timeline.push({ event: "AnalyticsArchived", description: "Analysis archived.", performedBy: userId || null });
    await analysis.save();

    await AuditLogModel.create({ action: "finance.analytics.archive", module: "Finance", resource: "FinancialAnalytics", resourceId: analysis._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("AnalyticsArchived", { tenantId, analysisId: analysis._id.toString(), performedBy: userId || null });

    return analysis.toJSON();
  }
}

export default FinancialAnalyticsService;
