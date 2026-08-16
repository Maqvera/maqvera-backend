import { v4 as uuidv4 } from "uuid";
import EnterpriseBudgetModel from "../models/EnterpriseBudgetModel.js";
import FinancialForecastModel from "../models/FinancialForecastModel.js";
import VarianceAnalysisModel from "../models/VarianceAnalysisModel.js";
import ScenarioModel from "../models/ScenarioModel.js";
import InvoiceModel from "../models/InvoiceModel.js";
import ExpenseModel from "../models/ExpenseModel.js";
import PaymentModel from "../models/PaymentModel.js";
import ReceiptModel from "../models/ReceiptModel.js";
import LedgerEntryModel from "../models/LedgerEntryModel.js";
import { publishEvent } from "../utils/eventBus.js";
import getFinanceConfig from "../utils/financeConfig.js";

const roundCurrency = (val) => Math.round((Number(val) || 0) * 100) / 100;

class EnterprisePlanningService {
  /**
   * Create a new draft Enterprise Budget
   */
  async createBudget(tenantId, data, userId) {
    if (!tenantId) throw new Error("Tenant ID is required.");
    if (!data.name) throw new Error("Budget name is required.");
    if (!data.fiscalYear) throw new Error("Fiscal year is required.");
    if (!data.currency) throw new Error("Currency is required.");

    // Check for unique budget name for latest active budget version in tenant
    const existing = await EnterpriseBudgetModel.findOne({
      tenantId,
      name: data.name,
      fiscalYear: data.fiscalYear,
      isLatestVersion: true
    });

    if (existing) {
      throw new Error(`A budget with the name '${data.name}' already exists for fiscal year ${data.fiscalYear}.`);
    }

    const budgetId = `BDG-${data.fiscalYear.split("-")[0]}-${uuidv4().substring(0, 6).toUpperCase()}`;

    const lineItems = Array.isArray(data.lineItems) ? data.lineItems.map(item => ({
      code: item.code || null,
      accountCode: item.accountCode || null,
      category: item.category || "Expense",
      name: item.name || "Budget Item",
      allocatedAmount: roundCurrency(item.allocatedAmount || 0),
      periodBreakdown: item.periodBreakdown || {},
      notes: item.notes || null
    })) : [];

    const totalAmount = roundCurrency(
      lineItems.reduce((sum, item) => sum + (item.allocatedAmount || 0), 0)
    );

    const budget = await EnterpriseBudgetModel.create({
      tenantId,
      budgetId,
      name: data.name,
      department: data.department || "All",
      fiscalYear: data.fiscalYear,
      currency: data.currency.toUpperCase(),
      budgetType: data.budgetType || "Annual",
      version: 1,
      isLatestVersion: true,
      parentBudgetId: null,
      status: "Draft",
      approvalStatus: "Pending",
      owner: data.owner || userId || "Finance Admin",
      description: data.description || null,
      periodStart: data.periodStart ? new Date(data.periodStart) : null,
      periodEnd: data.periodEnd ? new Date(data.periodEnd) : null,
      lineItems,
      totalAmount,
      createdBy: userId,
      updatedBy: userId
    });

    publishEvent("BudgetCreated", {
      tenantId,
      budgetId: budget.budgetId,
      name: budget.name,
      department: budget.department,
      fiscalYear: budget.fiscalYear,
      currency: budget.currency,
      totalAmount: budget.totalAmount,
      createdBy: userId
    });

    return budget;
  }

  /**
   * List Enterprise Budgets with filters
   */
  async listBudgets(tenantId, filters = {}) {
    const query = { tenantId };

    if (filters.status) query.status = filters.status;
    if (filters.department) query.department = filters.department;
    if (filters.fiscalYear) query.fiscalYear = filters.fiscalYear;
    if (filters.budgetType) query.budgetType = filters.budgetType;
    if (filters.isLatestVersion !== undefined) {
      query.isLatestVersion = filters.isLatestVersion === "true" || filters.isLatestVersion === true;
    } else {
      query.isLatestVersion = true; // Default to latest versions
    }

    if (filters.search) {
      query.$or = [
        { name: { $regex: filters.search, $options: "i" } },
        { budgetId: { $regex: filters.search, $options: "i" } },
        { owner: { $regex: filters.search, $options: "i" } }
      ];
    }

    const page = parseInt(filters.page || 1, 10);
    const limit = parseInt(filters.limit || 50, 10);
    const skip = (page - 1) * limit;

    const [budgets, total] = await Promise.all([
      EnterpriseBudgetModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      EnterpriseBudgetModel.countDocuments(query)
    ]);

    return {
      budgets,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get single Enterprise Budget by ID
   */
  async getBudgetById(tenantId, budgetId) {
    const budget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId }).lean();
    if (!budget) {
      throw new Error(`Budget '${budgetId}' not found.`);
    }
    return budget;
  }

  /**
   * Update an existing Enterprise Budget (Rule: Never Modify Published Budgets!)
   */
  async updateBudget(tenantId, budgetId, updateData, userId) {
    const budget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId });
    if (!budget) throw new Error(`Budget '${budgetId}' not found.`);

    // AI Rule: Never Modify Published Budgets
    if (budget.status === "Published") {
      throw new Error("Published budgets cannot be modified directly. Create a new budget revision/version instead.");
    }

    if (updateData.name) budget.name = updateData.name;
    if (updateData.department) budget.department = updateData.department;
    if (updateData.currency) budget.currency = updateData.currency.toUpperCase();
    if (updateData.budgetType) budget.budgetType = updateData.budgetType;
    if (updateData.owner) budget.owner = updateData.owner;
    if (updateData.description !== undefined) budget.description = updateData.description;
    if (updateData.periodStart) budget.periodStart = new Date(updateData.periodStart);
    if (updateData.periodEnd) budget.periodEnd = new Date(updateData.periodEnd);

    if (Array.isArray(updateData.lineItems)) {
      budget.lineItems = updateData.lineItems.map(item => ({
        code: item.code || null,
        accountCode: item.accountCode || null,
        category: item.category || "Expense",
        name: item.name || "Budget Item",
        allocatedAmount: roundCurrency(item.allocatedAmount || 0),
        periodBreakdown: item.periodBreakdown || {},
        notes: item.notes || null
      }));
      budget.totalAmount = roundCurrency(
        budget.lineItems.reduce((sum, item) => sum + (item.allocatedAmount || 0), 0)
      );
    }

    budget.updatedBy = userId;
    await budget.save();
    return budget;
  }

  /**
   * Submit budget for approval
   */
  async submitBudget(tenantId, budgetId, userId) {
    const budget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId });
    if (!budget) throw new Error(`Budget '${budgetId}' not found.`);

    if (budget.status === "Published") {
      throw new Error("Budget is already published.");
    }

    budget.status = "Submitted";
    budget.approvalStatus = "Submitted";
    budget.updatedBy = userId;
    await budget.save();

    return budget;
  }

  /**
   * Approve budget decision (Approve / Reject / RevisionRequested)
   */
  async approveBudget(tenantId, budgetId, decision, comments, userId) {
    const budget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId });
    if (!budget) throw new Error(`Budget '${budgetId}' not found.`);

    if (budget.status !== "Submitted") {
      throw new Error(`Budget status is '${budget.status}'. Only 'Submitted' budgets can be approved.`);
    }

    if (decision === "Approved") {
      budget.status = "Approved";
      budget.approvalStatus = "Approved";
      budget.approvedAt = new Date();
      budget.approvedBy = userId;

      publishEvent("BudgetApproved", {
        tenantId,
        budgetId: budget.budgetId,
        name: budget.name,
        fiscalYear: budget.fiscalYear,
        approvedBy: userId,
        approvedAt: budget.approvedAt
      });
    } else if (decision === "Rejected") {
      budget.status = "Draft";
      budget.approvalStatus = "Rejected";
    } else {
      budget.status = "Draft";
      budget.approvalStatus = "RevisionRequested";
    }

    if (comments) budget.description = `${budget.description || ''}\n[Approval Note]: ${comments}`.trim();
    budget.updatedBy = userId;
    await budget.save();

    return budget;
  }

  /**
   * Publish budget
   */
  async publishBudget(tenantId, budgetId, userId) {
    const budget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId });
    if (!budget) throw new Error(`Budget '${budgetId}' not found.`);

    if (budget.status === "Published") {
      throw new Error(`Budget '${budgetId}' is already published.`);
    }

    budget.status = "Published";
    budget.approvalStatus = "Approved";
    budget.publishedAt = new Date();
    budget.publishedBy = userId;
    budget.updatedBy = userId;
    await budget.save();

    publishEvent("BudgetPublished", {
      tenantId,
      budgetId: budget.budgetId,
      name: budget.name,
      fiscalYear: budget.fiscalYear,
      publishedBy: userId,
      publishedAt: budget.publishedAt
    });

    return budget;
  }

  /**
   * Create new Budget Revision (Rule: Version Every Budget Revision)
   */
  async createBudgetRevision(tenantId, budgetId, revisionData = {}, userId) {
    const parentBudget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId });
    if (!parentBudget) throw new Error(`Budget '${budgetId}' not found.`);

    const newVersion = parentBudget.version + 1;

    // Mark current version as not latest
    parentBudget.isLatestVersion = false;
    await parentBudget.save();

    const newBudgetId = `BDG-${parentBudget.fiscalYear.split("-")[0]}-V${newVersion}-${uuidv4().substring(0, 4).toUpperCase()}`;

    const lineItems = Array.isArray(revisionData.lineItems)
      ? revisionData.lineItems.map(item => ({
          code: item.code || null,
          accountCode: item.accountCode || null,
          category: item.category || "Expense",
          name: item.name || "Budget Item",
          allocatedAmount: roundCurrency(item.allocatedAmount || 0),
          periodBreakdown: item.periodBreakdown || {},
          notes: item.notes || null
        }))
      : parentBudget.lineItems.map(item => ({ ...item.toObject() }));

    const totalAmount = roundCurrency(
      lineItems.reduce((sum, item) => sum + (item.allocatedAmount || 0), 0)
    );

    const revisionSnapshot = {
      version: parentBudget.version,
      changedBy: userId,
      changedAt: new Date(),
      reason: revisionData.reason || "Budget revision created",
      totalAmount: parentBudget.totalAmount,
      snapshot: {
        lineItems: parentBudget.lineItems,
        totalAmount: parentBudget.totalAmount
      }
    };

    const newBudget = await EnterpriseBudgetModel.create({
      tenantId,
      budgetId: newBudgetId,
      name: parentBudget.name,
      department: revisionData.department || parentBudget.department,
      fiscalYear: parentBudget.fiscalYear,
      currency: parentBudget.currency,
      budgetType: parentBudget.budgetType,
      version: newVersion,
      isLatestVersion: true,
      parentBudgetId: parentBudget.budgetId,
      status: "Draft",
      approvalStatus: "Pending",
      owner: parentBudget.owner,
      description: revisionData.description || `Revision v${newVersion} of ${parentBudget.name}`,
      periodStart: parentBudget.periodStart,
      periodEnd: parentBudget.periodEnd,
      lineItems,
      totalAmount,
      revisionReason: revisionData.reason || "Budget revision",
      revisionHistory: [...(parentBudget.revisionHistory || []), revisionSnapshot],
      createdBy: userId,
      updatedBy: userId
    });

    return newBudget;
  }

  /**
   * Get all revisions for a budget chain
   */
  async getBudgetRevisions(tenantId, budgetId) {
    const target = await EnterpriseBudgetModel.findOne({ tenantId, budgetId }).lean();
    if (!target) throw new Error(`Budget '${budgetId}' not found.`);

    const revisions = await EnterpriseBudgetModel.find({
      tenantId,
      name: target.name,
      fiscalYear: target.fiscalYear
    }).sort({ version: 1 }).lean();

    return revisions;
  }

  /**
   * Generate Financial Forecast
   */
  async generateForecast(tenantId, data, userId) {
    if (!tenantId) throw new Error("Tenant ID is required.");
    if (!data.name) throw new Error("Forecast name is required.");
    if (!data.fiscalYear) throw new Error("Fiscal year is required.");

    const forecastType = data.forecastType || "Revenue";
    const methodology = data.methodology || "LinearTrend";
    const growthRate = Number(data.growthRate || 0);

    const forecastId = `FCST-${data.fiscalYear.split("-")[0]}-${uuidv4().substring(0, 6).toUpperCase()}`;

    let baseBudget = null;
    if (data.baseBudgetId) {
      baseBudget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId: data.baseBudgetId }).lean();
    }

    // Query historical system records (Invoices for Revenue, Expenses for Expense)
    const [invoices, expenses] = await Promise.all([
      InvoiceModel.find({ tenantId, status: { $in: ["Issued", "Paid"] } }).select("totalAmount createdAt").lean(),
      ExpenseModel.find({ tenantId, status: { $in: ["Approved", "Reimbursed", "Closed"] } }).select("amount createdAt").lean()
    ]);

    const historicalRev = invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const historicalExp = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

    // Calculate baseline quarterly/monthly buckets for the projected year
    const periods = ["Q1", "Q2", "Q3", "Q4"];
    const baseRevenueQuarterly = baseBudget ? baseBudget.totalAmount * 0.6 / 4 : (historicalRev > 0 ? historicalRev / 4 : 50000);
    const baseExpenseQuarterly = baseBudget ? baseBudget.totalAmount * 0.4 / 4 : (historicalExp > 0 ? historicalExp / 4 : 30000);

    const mult = 1 + (growthRate / 100);

    const buckets = periods.map((p, idx) => {
      const stepMult = Math.pow(mult, idx + 1);
      const projRev = roundCurrency(baseRevenueQuarterly * stepMult);
      const projExp = roundCurrency(baseExpenseQuarterly * stepMult);
      const projProf = roundCurrency(projRev - projExp);
      const projCash = roundCurrency(projProf * 0.95);

      return {
        period: `${p} ${data.fiscalYear}`,
        projectedRevenue: projRev,
        projectedExpense: projExp,
        projectedProfit: projProf,
        projectedCashFlow: projCash,
        projectedAmount: forecastType === "Expense" ? projExp : projRev,
        confidence: 0.85,
        notes: `Projected via ${methodology}`
      };
    });

    const totalRev = roundCurrency(buckets.reduce((s, b) => s + b.projectedRevenue, 0));
    const totalExp = roundCurrency(buckets.reduce((s, b) => s + b.projectedExpense, 0));
    const totalProf = roundCurrency(totalRev - totalExp);
    const totalCash = roundCurrency(buckets.reduce((s, b) => s + b.projectedCashFlow, 0));

    const forecast = await FinancialForecastModel.create({
      tenantId,
      forecastId,
      name: data.name,
      forecastType,
      fiscalYear: data.fiscalYear,
      baseBudgetId: data.baseBudgetId || null,
      currency: data.currency || (baseBudget ? baseBudget.currency : "USD"),
      methodology,
      growthRate,
      startDate: data.startDate ? new Date(data.startDate) : new Date(`${data.fiscalYear.split("-")[0]}-01-01`),
      endDate: data.endDate ? new Date(data.endDate) : new Date(`${data.fiscalYear.split("-")[0]}-12-31`),
      buckets,
      totalProjectedRevenue: totalRev,
      totalProjectedExpense: totalExp,
      totalProjectedProfit: totalProf,
      totalProjectedCashFlow: totalCash,
      confidenceLevel: (invoices.length + expenses.length) > 10 ? "High" : "Medium",
      status: "Active",
      generatedBy: userId,
      notes: data.notes || null
    });

    publishEvent("ForecastGenerated", {
      tenantId,
      forecastId: forecast.forecastId,
      name: forecast.name,
      forecastType: forecast.forecastType,
      fiscalYear: forecast.fiscalYear,
      totalProjectedRevenue: forecast.totalProjectedRevenue,
      totalProjectedExpense: forecast.totalProjectedExpense,
      generatedBy: userId
    });

    return forecast;
  }

  /**
   * List Forecasts
   */
  async listForecasts(tenantId, filters = {}) {
    const query = { tenantId };
    if (filters.forecastType) query.forecastType = filters.forecastType;
    if (filters.fiscalYear) query.fiscalYear = filters.fiscalYear;
    if (filters.status) query.status = filters.status;

    const page = parseInt(filters.page || 1, 10);
    const limit = parseInt(filters.limit || 50, 10);
    const skip = (page - 1) * limit;

    const [forecasts, total] = await Promise.all([
      FinancialForecastModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FinancialForecastModel.countDocuments(query)
    ]);

    return {
      forecasts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    };
  }

  /**
   * Get single Forecast by ID
   */
  async getForecastById(tenantId, forecastId) {
    const forecast = await FinancialForecastModel.findOne({ tenantId, forecastId }).lean();
    if (!forecast) throw new Error(`Forecast '${forecastId}' not found.`);
    return forecast;
  }

  /**
   * Automatically Calculate Variance (Budget vs Actual / Forecast vs Actual)
   */
  async calculateVariance(tenantId, data, userId) {
    if (!tenantId) throw new Error("Tenant ID is required.");
    if (!data.fiscalYear) throw new Error("Fiscal year is required.");

    const varianceType = data.varianceType || "BudgetVsActual";
    const varianceId = `VAR-${data.fiscalYear.split("-")[0]}-${uuidv4().substring(0, 6).toUpperCase()}`;

    let targetBudget = null;
    let targetForecast = null;

    if (data.budgetId) {
      targetBudget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId: data.budgetId }).lean();
    } else {
      targetBudget = await EnterpriseBudgetModel.findOne({ tenantId, fiscalYear: data.fiscalYear, isLatestVersion: true }).lean();
    }

    if (data.forecastId) {
      targetForecast = await FinancialForecastModel.findOne({ tenantId, forecastId: data.forecastId }).lean();
    }

    // Determine target amount
    let targetAmount = 0;
    if (varianceType.includes("Expense")) {
      targetAmount = targetBudget ? targetBudget.totalAmount : (targetForecast ? targetForecast.totalProjectedExpense : 100000);
    } else if (varianceType.includes("Revenue")) {
      targetAmount = targetForecast ? targetForecast.totalProjectedRevenue : (targetBudget ? targetBudget.totalAmount : 150000);
    } else {
      targetAmount = targetBudget ? targetBudget.totalAmount : (targetForecast ? targetForecast.totalProjectedRevenue : 100000);
    }

    // Query ACTUAL amounts from system GL / modules
    const [invoices, expenses] = await Promise.all([
      InvoiceModel.find({ tenantId, status: { $in: ["Issued", "Paid"] } }).select("totalAmount").lean(),
      ExpenseModel.find({ tenantId, status: { $in: ["Approved", "Reimbursed", "Closed"] } }).select("amount category").lean()
    ]);

    const actualRevenue = invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const actualExpense = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

    let actualAmount = 0;
    let varianceAmount = 0;
    let favorable = true;

    if (varianceType.includes("Expense")) {
      actualAmount = actualExpense;
      varianceAmount = roundCurrency(targetAmount - actualAmount); // Favorable if target > actual (spent less than budgeted)
      favorable = varianceAmount >= 0;
    } else if (varianceType.includes("Revenue")) {
      actualAmount = actualRevenue;
      varianceAmount = roundCurrency(actualAmount - targetAmount); // Favorable if actual > target (earned more)
      favorable = varianceAmount >= 0;
    } else { // BudgetVsActual or ForecastVsActual overall
      actualAmount = actualExpense;
      varianceAmount = roundCurrency(targetAmount - actualAmount);
      favorable = varianceAmount >= 0;
    }

    const variancePercentage = targetAmount ? roundCurrency((varianceAmount / targetAmount) * 100) : 0;

    // Category breakdown comparison
    const categoryBreakdown = [];
    if (targetBudget && targetBudget.lineItems && targetBudget.lineItems.length > 0) {
      for (const line of targetBudget.lineItems) {
        const catExpenses = expenses.filter(e => e.category === line.category || e.category === line.name);
        const catActual = catExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
        const catTarget = line.allocatedAmount || 0;
        const catVar = roundCurrency(catTarget - catActual);
        const catVarPct = catTarget ? roundCurrency((catVar / catTarget) * 100) : 0;

        categoryBreakdown.push({
          category: line.name || line.category,
          target: catTarget,
          actual: catActual,
          variance: catVar,
          variancePct: catVarPct,
          favorable: catVar >= 0
        });
      }
    }

    const varianceRecord = await VarianceAnalysisModel.create({
      tenantId,
      varianceId,
      name: data.name || `${varianceType} ${data.fiscalYear}`,
      varianceType,
      budgetId: targetBudget ? targetBudget.budgetId : null,
      forecastId: targetForecast ? targetForecast.forecastId : null,
      fiscalYear: data.fiscalYear,
      period: data.period || "FY",
      currency: data.currency || (targetBudget ? targetBudget.currency : "USD"),
      targetAmount,
      actualAmount,
      varianceAmount,
      variancePercentage,
      favorable,
      categoryBreakdown,
      calculatedAt: new Date(),
      calculatedBy: userId
    });

    publishEvent("VarianceCalculated", {
      tenantId,
      varianceId: varianceRecord.varianceId,
      varianceType: varianceRecord.varianceType,
      fiscalYear: varianceRecord.fiscalYear,
      targetAmount: varianceRecord.targetAmount,
      actualAmount: varianceRecord.actualAmount,
      varianceAmount: varianceRecord.varianceAmount,
      favorable: varianceRecord.favorable,
      calculatedBy: userId
    });

    return varianceRecord;
  }

  /**
   * List Variances
   */
  async listVariances(tenantId, filters = {}) {
    const query = { tenantId };
    if (filters.varianceType) query.varianceType = filters.varianceType;
    if (filters.fiscalYear) query.fiscalYear = filters.fiscalYear;
    if (filters.budgetId) query.budgetId = filters.budgetId;

    const page = parseInt(filters.page || 1, 10);
    const limit = parseInt(filters.limit || 50, 10);
    const skip = (page - 1) * limit;

    const [variances, total] = await Promise.all([
      VarianceAnalysisModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      VarianceAnalysisModel.countDocuments(query)
    ]);

    return {
      variances,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    };
  }

  /**
   * Get Variance by ID
   */
  async getVarianceById(tenantId, varianceId) {
    const variance = await VarianceAnalysisModel.findOne({ tenantId, varianceId }).lean();
    if (!variance) throw new Error(`Variance analysis '${varianceId}' not found.`);
    return variance;
  }

  /**
   * Create Scenario
   */
  async createScenario(tenantId, data, userId) {
    if (!tenantId) throw new Error("Tenant ID is required.");
    if (!data.name) throw new Error("Scenario name is required.");
    if (!data.fiscalYear) throw new Error("Fiscal year is required.");

    const scenarioType = data.scenarioType || "ExpectedCase";
    const scenarioId = `SCN-${data.fiscalYear.split("-")[0]}-${uuidv4().substring(0, 6).toUpperCase()}`;

    const assumptions = {
      revenueMultiplier: Number(data.assumptions?.revenueMultiplier ?? 1.0),
      expenseMultiplier: Number(data.assumptions?.expenseMultiplier ?? 1.0),
      inflationRate: Number(data.assumptions?.inflationRate ?? 0),
      headcountGrowthPct: Number(data.assumptions?.headcountGrowthPct ?? 0),
      customParameters: data.assumptions?.customParameters || {}
    };

    const scenario = await ScenarioModel.create({
      tenantId,
      scenarioId,
      name: data.name,
      scenarioType,
      baseBudgetId: data.baseBudgetId || null,
      baseForecastId: data.baseForecastId || null,
      fiscalYear: data.fiscalYear,
      currency: data.currency || "USD",
      assumptions,
      description: data.description || null
    });

    return scenario;
  }

  /**
   * List Scenarios
   */
  async listScenarios(tenantId, filters = {}) {
    const query = { tenantId };
    if (filters.scenarioType) query.scenarioType = filters.scenarioType;
    if (filters.fiscalYear) query.fiscalYear = filters.fiscalYear;

    const page = parseInt(filters.page || 1, 10);
    const limit = parseInt(filters.limit || 50, 10);
    const skip = (page - 1) * limit;

    const [scenarios, total] = await Promise.all([
      ScenarioModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ScenarioModel.countDocuments(query)
    ]);

    return {
      scenarios,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    };
  }

  /**
   * Get Scenario by ID
   */
  async getScenarioById(tenantId, scenarioId) {
    const scenario = await ScenarioModel.findOne({ tenantId, scenarioId }).lean();
    if (!scenario) throw new Error(`Scenario '${scenarioId}' not found.`);
    return scenario;
  }

  /**
   * Evaluate Scenario (Run what-if analysis)
   */
  async evaluateScenario(tenantId, scenarioId, userId) {
    const scenario = await ScenarioModel.findOne({ tenantId, scenarioId });
    if (!scenario) throw new Error(`Scenario '${scenarioId}' not found.`);

    let baselineRevenue = 200000;
    let baselineExpense = 120000;

    if (scenario.baseBudgetId) {
      const budget = await EnterpriseBudgetModel.findOne({ tenantId, budgetId: scenario.baseBudgetId }).lean();
      if (budget) {
        baselineExpense = budget.totalAmount;
        baselineRevenue = roundCurrency(budget.totalAmount * 1.4);
      }
    } else if (scenario.baseForecastId) {
      const fcst = await FinancialForecastModel.findOne({ tenantId, forecastId: scenario.baseForecastId }).lean();
      if (fcst) {
        baselineRevenue = fcst.totalProjectedRevenue || baselineRevenue;
        baselineExpense = fcst.totalProjectedExpense || baselineExpense;
      }
    }

    const revMult = scenario.assumptions.revenueMultiplier || 1.0;
    const expMult = scenario.assumptions.expenseMultiplier || 1.0;
    const infl = 1 + ((scenario.assumptions.inflationRate || 0) / 100);
    const hc = 1 + ((scenario.assumptions.headcountGrowthPct || 0) / 100);

    const projectedRevenue = roundCurrency(baselineRevenue * revMult);
    const projectedExpense = roundCurrency(baselineExpense * expMult * infl * hc);
    const baselineProfit = roundCurrency(baselineRevenue - baselineExpense);
    const projectedProfit = roundCurrency(projectedRevenue - projectedExpense);

    const varianceToBaseline = roundCurrency(projectedProfit - baselineProfit);
    const varianceToBaselinePct = baselineProfit ? roundCurrency((varianceToBaseline / Math.abs(baselineProfit)) * 100) : 0;

    scenario.projectedOutcome = {
      baselineRevenue,
      projectedRevenue,
      baselineExpense,
      projectedExpense,
      baselineProfit,
      projectedProfit,
      varianceToBaseline,
      varianceToBaselinePct
    };

    scenario.evaluatedAt = new Date();
    scenario.evaluatedBy = userId;
    await scenario.save();

    publishEvent("ScenarioEvaluated", {
      tenantId,
      scenarioId: scenario.scenarioId,
      scenarioType: scenario.scenarioType,
      fiscalYear: scenario.fiscalYear,
      projectedRevenue: scenario.projectedOutcome.projectedRevenue,
      projectedExpense: scenario.projectedOutcome.projectedExpense,
      projectedProfit: scenario.projectedOutcome.projectedProfit,
      varianceToBaseline: scenario.projectedOutcome.varianceToBaseline,
      evaluatedBy: userId
    });

    return scenario;
  }

  /**
   * Aggregated Executive Planning Dashboard
   */
  async getPlanningDashboard(tenantId, filters = {}) {
    const fiscalYear = filters.fiscalYear || "2028";

    const [budgets, forecasts, invoices, expenses, scenarios] = await Promise.all([
      EnterpriseBudgetModel.find({ tenantId, fiscalYear, isLatestVersion: true }).lean(),
      FinancialForecastModel.find({ tenantId, fiscalYear, status: "Active" }).lean(),
      InvoiceModel.find({ tenantId, status: { $in: ["Issued", "Paid"] } }).select("totalAmount").lean(),
      ExpenseModel.find({ tenantId, status: { $in: ["Approved", "Reimbursed", "Closed"] } }).select("amount category").lean(),
      ScenarioModel.find({ tenantId, fiscalYear }).lean()
    ]);

    const totalBudgeted = roundCurrency(budgets.reduce((sum, b) => sum + (b.totalAmount || 0), 0));
    const totalActualRevenue = roundCurrency(invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0));
    const totalActualExpense = roundCurrency(expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0));
    const totalActualProfit = roundCurrency(totalActualRevenue - totalActualExpense);

    const totalForecastedRevenue = roundCurrency(forecasts.reduce((sum, f) => sum + (f.totalProjectedRevenue || 0), 0));
    const totalForecastedExpense = roundCurrency(forecasts.reduce((sum, f) => sum + (f.totalProjectedExpense || 0), 0));

    const budgetUtilizationPct = totalBudgeted ? roundCurrency((totalActualExpense / totalBudgeted) * 100) : 0;
    const forecastAccuracyPct = totalForecastedRevenue
      ? roundCurrency(100 - Math.abs(((totalActualRevenue - totalForecastedRevenue) / totalForecastedRevenue) * 100))
      : 100;

    const departmentBudgets = budgets.map(b => ({
      department: b.department,
      budgetName: b.name,
      allocatedAmount: b.totalAmount,
      status: b.status,
      owner: b.owner
    }));

    const dashboardData = {
      fiscalYear,
      currency: filters.currency || "USD",
      metrics: {
        totalBudgeted,
        totalActualRevenue,
        totalActualExpense,
        totalActualProfit,
        totalForecastedRevenue,
        totalForecastedExpense,
        budgetUtilizationPct,
        forecastAccuracyPct
      },
      counts: {
        activeBudgets: budgets.length,
        activeForecasts: forecasts.length,
        evaluatedScenarios: scenarios.filter(s => s.evaluatedAt).length
      },
      departmentBudgets,
      scenariosSummary: scenarios.map(s => ({
        scenarioId: s.scenarioId,
        name: s.name,
        scenarioType: s.scenarioType,
        projectedRevenue: s.projectedOutcome?.projectedRevenue || 0,
        projectedExpense: s.projectedOutcome?.projectedExpense || 0,
        projectedProfit: s.projectedOutcome?.projectedProfit || 0
      })),
      updatedAt: new Date()
    };

    publishEvent("PlanningDashboardUpdated", {
      tenantId,
      fiscalYear,
      metrics: dashboardData.metrics,
      updatedAt: dashboardData.updatedAt
    });

    return dashboardData;
  }
}

export default new EnterprisePlanningService();
