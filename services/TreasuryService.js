import BankAccountModel from "../models/BankAccountModel.js";
import CashLocationModel from "../models/CashLocationModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import TreasuryCashPositionModel from "../models/TreasuryCashPositionModel.js";
import TreasuryInvestmentModel from "../models/TreasuryInvestmentModel.js";
import TreasuryDebtModel from "../models/TreasuryDebtModel.js";
import TreasuryLiquidityForecastModel from "../models/TreasuryLiquidityForecastModel.js";
import TreasuryFXExposureModel from "../models/TreasuryFXExposureModel.js";
import TreasuryRiskModel from "../models/TreasuryRiskModel.js";
import { publishEvent } from "../utils/eventBus.js";
import CurrencyService from "./CurrencyService.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Enterprise Treasury Management Service — Part 18 (TMS).
 * Centralized cash position, liquidity forecasting, bank connectivity,
 * investments, debt administration, FX exposure, and continuous treasury risk controls.
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
class TreasuryService {
  /**
   * Generates a unique sequential identifier for treasury records
   */
  static generateId(prefix = "TR") {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Endpoint: POST /api/v1/treasury/cash-position
   * Business Workflow: Validate Company -> Collect Bank Balances -> Collect Cash Accounts ->
   * Calculate Available Cash -> Calculate Restricted Cash -> Publish CashPositionCalculated -> Return Success
   */
  static async calculateCashPosition({ tenantId, valuationDate, userId = null }) {
    if (!tenantId) {
      throw new Error("tenantId is required to calculate cash position.");
    }

    const valDate = valuationDate ? new Date(valuationDate) : new Date();

    // 1. Collect Bank Accounts
    const bankAccounts = await BankAccountModel.find({
      tenantId,
      status: { $in: ["Active", "Verified"] }
    }).lean();

    let totalAvailableBankCash = 0;
    let totalRestrictedBankCash = 0;

    const accountSnapshots = bankAccounts.map((acc) => {
      const avail = acc.balances?.available || 0;
      const restr = acc.balances?.frozen || 0;
      const curr = acc.balances?.current || (avail + restr);

      totalAvailableBankCash += avail;
      totalRestrictedBankCash += restr;

      return {
        accountId: acc._id.toString(),
        accountName: acc.accountName,
        bankName: acc.bankName,
        currency: acc.currency,
        accountType: acc.accountType,
        currentBalance: curr,
        availableBalance: avail,
        restrictedBalance: restr,
        isVirtual: acc.isVirtual || false
      };
    });

    // 2. Collect Cash Locations / Petty Cash
    const cashLocations = await CashLocationModel.find({ tenantId, status: "Active" }).lean();
    let pettyCashTotal = 0;
    cashLocations.forEach((loc) => {
      pettyCashTotal += loc.currentBalance || loc.balance || 0;
    });

    const availableCash = totalAvailableBankCash + pettyCashTotal;
    const restrictedCash = totalRestrictedBankCash;
    const totalCash = availableCash + restrictedCash;

    // 3. Upsert position record for valuationDate
    const startOfDay = new Date(valDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(valDate);
    endOfDay.setHours(23, 59, 59, 999);

    let cashPosition = await TreasuryCashPositionModel.findOne({
      tenantId,
      valuationDate: { $gte: startOfDay, $lte: endOfDay }
    });

    if (!cashPosition) {
      cashPosition = new TreasuryCashPositionModel({
        tenantId,
        positionId: this.generateId("TCP"),
        valuationDate: valDate,
        baseCurrency: "USD",
        totalCash,
        availableCash,
        restrictedCash,
        pettyCash: pettyCashTotal,
        accountSnapshots,
        calculatedAt: new Date(),
        calculatedBy: userId
      });
    } else {
      cashPosition.totalCash = totalCash;
      cashPosition.availableCash = availableCash;
      cashPosition.restrictedCash = restrictedCash;
      cashPosition.pettyCash = pettyCashTotal;
      cashPosition.accountSnapshots = accountSnapshots;
      cashPosition.calculatedAt = new Date();
      cashPosition.calculatedBy = userId || cashPosition.calculatedBy;
    }

    await cashPosition.save();

    // 4. Publish Domain Event
    publishEvent("CashPositionCalculated", {
      tenantId,
      positionId: cashPosition.positionId,
      valuationDate: cashPosition.valuationDate,
      totalCash: cashPosition.totalCash,
      availableCash: cashPosition.availableCash,
      restrictedCash: cashPosition.restrictedCash,
      pettyCash: cashPosition.pettyCash
    });

    return cashPosition;
  }

  /**
   * GET /api/v1/treasury/cash-position
   * Returns latest calculated cash position snapshot or calculates it on the fly.
   */
  static async getLatestCashPosition({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");

    let position = await TreasuryCashPositionModel.findOne({ tenantId })
      .sort({ valuationDate: -1, createdAt: -1 })
      .lean();

    if (!position) {
      position = await this.calculateCashPosition({ tenantId });
      position = position.toJSON ? position.toJSON() : position;
    }

    return position;
  }

  /**
   * Endpoint: GET /api/v1/treasury/dashboard
   * Business Purpose: Returns executive treasury dashboard.
   * Includes: Available Cash, Restricted Cash, Liquidity Ratio, Upcoming Payments,
   * Upcoming Receipts, Debt Exposure, FX Exposure, Investment Value.
   */
  static async getTreasuryDashboard({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");

    // 1. Available & Restricted Cash
    const cashPos = await this.getLatestCashPosition({ tenantId });

    // 2. Upcoming Payments (AP outstanding)
    const apAggregate = await AccountsPayableModel.aggregate([
      { $match: { tenantId, status: { $in: ["Approved", "Pending", "PartiallyPaid"] } } },
      { $group: { _id: null, totalAP: { $sum: "$outstandingBalance" }, count: { $sum: 1 } } }
    ]);
    const upcomingPayments = apAggregate[0]?.totalAP || 0;

    // 3. Upcoming Receipts (AR outstanding)
    const arAggregate = await AccountsReceivableModel.aggregate([
      { $match: { tenantId, status: { $in: ["Active", "PartiallyPaid", "Overdue"] } } },
      { $group: { _id: null, totalAR: { $sum: "$outstandingBalance" }, count: { $sum: 1 } } }
    ]);
    const upcomingReceipts = arAggregate[0]?.totalAR || 0;

    // 4. Debt Exposure
    const debtAggregate = await TreasuryDebtModel.aggregate([
      { $match: { tenantId, status: "Active" } },
      { $group: { _id: null, totalDebt: { $sum: "$outstandingBalance" }, count: { $sum: 1 } } }
    ]);
    const debtExposure = debtAggregate[0]?.totalDebt || 0;

    // 5. Investment Value
    const investmentAggregate = await TreasuryInvestmentModel.aggregate([
      { $match: { tenantId, status: "Active" } },
      { $group: { _id: null, totalInvestments: { $sum: "$currentValue" }, count: { $sum: 1 } } }
    ]);
    const investmentValue = investmentAggregate[0]?.totalInvestments || 0;

    // 6. FX Exposure Total
    const fxExposures = await TreasuryFXExposureModel.find({ tenantId }).lean();
    const fxExposure = fxExposures.reduce((sum, item) => sum + Math.abs(item.unhedgedExposure || 0), 0);

    // 7. Liquidity Ratio calculation
    const shortTermLiabilities = upcomingPayments + (debtExposure * 0.1); // approx monthly debt principal
    const availableCashAndLiquidAssets = (cashPos.availableCash || 0) + investmentValue;
    const liquidityRatio = shortTermLiabilities > 0
      ? Number((availableCashAndLiquidAssets / shortTermLiabilities).toFixed(2))
      : 2.5;

    // 8. Active Risk Summary
    const activeRisks = await TreasuryRiskModel.find({
      tenantId,
      status: { $in: ["Warning", "Breached"] }
    }).lean();

    const dashboard = {
      valuationDate: cashPos.valuationDate || new Date(),
      availableCash: cashPos.availableCash || 0,
      restrictedCash: cashPos.restrictedCash || 0,
      totalCash: cashPos.totalCash || 0,
      pettyCash: cashPos.pettyCash || 0,
      liquidityRatio,
      upcomingPayments,
      upcomingReceipts,
      debtExposure,
      investmentValue,
      fxExposure,
      activeRiskCount: activeRisks.length,
      risksSummary: activeRisks.map(r => ({ riskType: r.riskType, severity: r.severity, status: r.status, metricName: r.metricName })),
      accountSnapshots: cashPos.accountSnapshots || [],
      lastUpdated: new Date()
    };

    // Publish event
    publishEvent("TreasuryDashboardUpdated", {
      tenantId,
      timestamp: dashboard.lastUpdated
    });

    return dashboard;
  }

  /**
   * Synchronize Bank Balances securely
   */
  static async syncBankBalances({ tenantId, bankAccountId = null, balanceOverrides = null, userId = null }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const filter = { tenantId, status: { $in: ["Active", "Verified"] } };
    if (bankAccountId) filter._id = bankAccountId;

    const accounts = await BankAccountModel.find(filter);
    const updatedAccounts = [];

    for (const acc of accounts) {
      if (balanceOverrides && balanceOverrides[acc._id.toString()]) {
        const newBal = balanceOverrides[acc._id.toString()];
        acc.balances.current = newBal.current ?? acc.balances.current;
        acc.balances.available = newBal.available ?? acc.balances.available;
      }
      acc.updatedBy = userId || acc.updatedBy;
      await acc.save();
      updatedAccounts.push(acc);
    }

    // Recalculate cash position
    await this.calculateCashPosition({ tenantId, userId });

    return {
      syncedCount: updatedAccounts.length,
      syncedAt: new Date()
    };
  }

  /**
   * Forecast Liquidity
   */
  static async generateLiquidityForecast({
    tenantId,
    horizon = "30-Day",
    baseCurrency = "USD",
    minimumBuffer = 50000,
    notes = null,
    userId = null
  }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const latestPos = await this.getLatestCashPosition({ tenantId });
    const startingLiquidity = latestPos.availableCash || 0;

    // Days calculation based on horizon
    let days = 30;
    if (horizon === "7-Day") days = 7;
    if (horizon === "90-Day") days = 90;
    if (horizon === "12-Month") days = 365;

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    // Projected Receipts (AR due within horizon)
    const arItems = await AccountsReceivableModel.aggregate([
      { $match: { tenantId, status: { $in: ["Active", "PartiallyPaid"] }, dueDate: { $lte: futureDate } } },
      { $group: { _id: null, total: { $sum: "$outstandingBalance" } } }
    ]);
    const projectedReceipts = arItems[0]?.total || 0;

    // Projected Disbursements (AP due + Debt due)
    const apItems = await AccountsPayableModel.aggregate([
      { $match: { tenantId, status: { $in: ["Approved", "Pending", "PartiallyPaid"] }, dueDate: { $lte: futureDate } } },
      { $group: { _id: null, total: { $sum: "$outstandingBalance" } } }
    ]);
    const apDisbursements = apItems[0]?.total || 0;

    const debtItems = await TreasuryDebtModel.aggregate([
      { $match: { tenantId, status: "Active", nextPaymentDate: { $lte: futureDate } } },
      { $group: { _id: null, total: { $sum: "$nextPaymentAmount" } } }
    ]);
    const debtDisbursements = debtItems[0]?.total || 0;

    const projectedDisbursements = apDisbursements + debtDisbursements;

    const endingLiquidity = startingLiquidity + projectedReceipts - projectedDisbursements;
    const shortfallAmount = Math.max(0, minimumBuffer - endingLiquidity);
    const workingCapitalRatio = projectedDisbursements > 0
      ? Number(((startingLiquidity + projectedReceipts) / projectedDisbursements).toFixed(2))
      : 2.0;

    // Generate periodic breakdown (4 periods)
    const forecastBreakdown = [];
    const stepDays = Math.max(1, Math.floor(days / 4));
    let currentCumulative = startingLiquidity;

    for (let i = 1; i <= 4; i++) {
      const stepDate = new Date();
      stepDate.setDate(stepDate.getDate() + (stepDays * i));

      const inCash = Math.round(projectedReceipts / 4);
      const outCash = Math.round(projectedDisbursements / 4);
      const net = inCash - outCash;
      currentCumulative += net;

      forecastBreakdown.push({
        period: `Period ${i}`,
        date: stepDate,
        incomingCash: inCash,
        outgoingCash: outCash,
        netCash: net,
        cumulativeCash: currentCumulative
      });
    }

    const forecast = new TreasuryLiquidityForecastModel({
      tenantId,
      forecastId: this.generateId("TLF"),
      horizon,
      baseCurrency,
      startingLiquidity,
      projectedReceipts,
      projectedDisbursements,
      endingLiquidity,
      minimumBuffer,
      shortfallAmount,
      workingCapitalRatio,
      forecastBreakdown,
      status: "Active",
      notes,
      generatedAt: new Date(),
      generatedBy: userId
    });

    await forecast.save();

    // Publish event
    publishEvent("LiquidityForecastGenerated", {
      tenantId,
      forecastId: forecast.forecastId,
      horizon,
      endingLiquidity,
      shortfallAmount,
      workingCapitalRatio
    });

    return forecast;
  }

  static async listLiquidityForecasts({ tenantId, status, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      TreasuryLiquidityForecastModel.find(query).sort({ generatedAt: -1 }).skip(skip).limit(limit).lean(),
      TreasuryLiquidityForecastModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  /**
   * Investment Management
   */
  static async createInvestment({
    tenantId,
    name,
    investmentType,
    counterpartyBank,
    currency = "USD",
    principalAmount,
    interestRate,
    startDate,
    maturityDate,
    notes = null,
    userId = null
  }) {
    if (!tenantId || !name || !investmentType || !counterpartyBank || !principalAmount || !maturityDate) {
      throw new Error("Missing required investment parameters (tenantId, name, investmentType, counterpartyBank, principalAmount, maturityDate).");
    }

    const start = startDate ? new Date(startDate) : new Date();
    const mat = new Date(maturityDate);

    // Simple annual yield calculation
    const yieldPct = interestRate || 5.0;
    const currentValue = principalAmount;

    const investment = new TreasuryInvestmentModel({
      tenantId,
      investmentId: this.generateId("INV"),
      name,
      investmentType,
      counterpartyBank,
      currency,
      principalAmount,
      currentValue,
      interestRate: yieldPct,
      yieldPct,
      startDate: start,
      maturityDate: mat,
      status: "Active",
      notes,
      createdBy: userId,
      updatedBy: userId
    });

    await investment.save();

    publishEvent("InvestmentCreated", {
      tenantId,
      investmentId: investment.investmentId,
      name: investment.name,
      investmentType: investment.investmentType,
      principalAmount: investment.principalAmount,
      maturityDate: investment.maturityDate
    });

    return investment;
  }

  static async listInvestments({ tenantId, status, investmentType, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;
    if (investmentType) query.investmentType = investmentType;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      TreasuryInvestmentModel.find(query).sort({ maturityDate: 1 }).skip(skip).limit(limit).lean(),
      TreasuryInvestmentModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  static async getInvestmentById({ tenantId, investmentId }) {
    if (!tenantId || !investmentId) throw new Error("tenantId and investmentId are required.");
    const investment = await TreasuryInvestmentModel.findOne({ tenantId, investmentId }).lean();
    if (!investment) throw new Error(`Investment ${investmentId} not found.`);
    return investment;
  }

  static async updateInvestmentStatus({ tenantId, investmentId, status, notes = null, userId = null }) {
    if (!tenantId || !investmentId || !status) throw new Error("tenantId, investmentId, and status are required.");
    const investment = await TreasuryInvestmentModel.findOne({ tenantId, investmentId });
    if (!investment) throw new Error(`Investment ${investmentId} not found.`);

    investment.status = status;
    if (notes) investment.notes = notes;
    investment.updatedBy = userId || investment.updatedBy;
    await investment.save();

    return investment;
  }

  /**
   * Debt & Loan Management
   */
  static async recordDebt({
    tenantId,
    facilityName,
    debtType,
    lender,
    currency = "USD",
    principalAmount,
    outstandingBalance,
    interestRate,
    interestType = "Fixed",
    startDate,
    maturityDate,
    repaymentFrequency = "Monthly",
    nextPaymentDate = null,
    nextPaymentAmount = 0,
    covenants = [],
    notes = null,
    userId = null
  }) {
    if (!tenantId || !facilityName || !debtType || !lender || !principalAmount || !maturityDate) {
      throw new Error("Missing required debt parameters (tenantId, facilityName, debtType, lender, principalAmount, maturityDate).");
    }

    const start = startDate ? new Date(startDate) : new Date();
    const mat = new Date(maturityDate);

    const debt = new TreasuryDebtModel({
      tenantId,
      debtId: this.generateId("DBT"),
      facilityName,
      debtType,
      lender,
      currency,
      principalAmount,
      outstandingBalance: outstandingBalance !== undefined ? outstandingBalance : principalAmount,
      interestRate: interestRate || 6.0,
      interestType,
      startDate: start,
      maturityDate: mat,
      repaymentFrequency,
      nextPaymentDate: nextPaymentDate ? new Date(nextPaymentDate) : null,
      nextPaymentAmount,
      covenants: covenants || [],
      status: "Active",
      notes,
      createdBy: userId,
      updatedBy: userId
    });

    await debt.save();

    publishEvent("DebtRecorded", {
      tenantId,
      debtId: debt.debtId,
      facilityName: debt.facilityName,
      debtType: debt.debtType,
      lender: debt.lender,
      principalAmount: debt.principalAmount,
      maturityDate: debt.maturityDate
    });

    return debt;
  }

  static async listDebts({ tenantId, status, debtType, page = 1, limit = 20 }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;
    if (debtType) query.debtType = debtType;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      TreasuryDebtModel.find(query).sort({ maturityDate: 1 }).skip(skip).limit(limit).lean(),
      TreasuryDebtModel.countDocuments(query)
    ]);

    return { data, total, page: Number(page), limit: Number(limit) };
  }

  static async getDebtById({ tenantId, debtId }) {
    if (!tenantId || !debtId) throw new Error("tenantId and debtId are required.");
    const debt = await TreasuryDebtModel.findOne({ tenantId, debtId }).lean();
    if (!debt) throw new Error(`Debt ${debtId} not found.`);
    return debt;
  }

  static async updateDebtStatus({ tenantId, debtId, status, outstandingBalance, notes = null, userId = null }) {
    if (!tenantId || !debtId) throw new Error("tenantId and debtId are required.");
    const debt = await TreasuryDebtModel.findOne({ tenantId, debtId });
    if (!debt) throw new Error(`Debt ${debtId} not found.`);

    if (status) debt.status = status;
    if (outstandingBalance !== undefined) debt.outstandingBalance = outstandingBalance;
    if (notes) debt.notes = notes;
    debt.updatedBy = userId || debt.updatedBy;
    await debt.save();

    return debt;
  }

  /**
   * Foreign Exchange (FX) Management
   */
  /**
   * File 4 Part 3 — "Never calculate exchange rates inside business
   * modules. Always use the centralized Conversion Engine." Fixed here: a
   * hardcoded `exchangeRate: 1.0` and a `baseCurrencyValue` that treated
   * the net FOREIGN-currency amount as if it were already base-currency
   * (mathematically wrong for any real non-1:1 pair) both previously
   * violated that rule directly — this now routes every conversion
   * through the real `CurrencyService.getRate`/`convert`, the same engine
   * every other Finance Part uses. A currency with no rate on file is
   * skipped for that one currency (real, honest — never fabricates a
   * rate), not a whole-request failure.
   */
  static async calculateFXExposure({ tenantId, baseCurrency = "USD", userId = null }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const config = getFinanceConfig();

    // Aggregates foreign bank balances, investments, AR (long positions) vs AP, Debts (short positions)
    const bankAccounts = await BankAccountModel.find({ tenantId, status: "Active" }).lean();
    const investments = await TreasuryInvestmentModel.find({ tenantId, status: "Active" }).lean();
    const debts = await TreasuryDebtModel.find({ tenantId, status: "Active" }).lean();

    const currencyMap = {};

    bankAccounts.forEach(acc => {
      if (acc.currency !== baseCurrency) {
        if (!currencyMap[acc.currency]) currencyMap[acc.currency] = { long: 0, short: 0 };
        currencyMap[acc.currency].long += (acc.balances?.available || 0);
      }
    });

    investments.forEach(inv => {
      if (inv.currency !== baseCurrency) {
        if (!currencyMap[inv.currency]) currencyMap[inv.currency] = { long: 0, short: 0 };
        currencyMap[inv.currency].long += (inv.currentValue || 0);
      }
    });

    debts.forEach(dbt => {
      if (dbt.currency !== baseCurrency) {
        if (!currencyMap[dbt.currency]) currencyMap[dbt.currency] = { long: 0, short: 0 };
        currencyMap[dbt.currency].short += (dbt.outstandingBalance || 0);
      }
    });

    const updatedExposures = [];

    for (const [currency, pos] of Object.entries(currencyMap)) {
      const net = pos.long - pos.short;
      const unhedged = net; // default 0 hedged
      const varPct = config.treasuryFxVarPercent;

      let exchangeRate = null;
      let baseCurrencyValue = null;
      try {
        const rateResult = await CurrencyService.getRate(tenantId, currency, baseCurrency);
        exchangeRate = rateResult.rate;
        baseCurrencyValue = (await CurrencyService.convert(Math.abs(net), currency, baseCurrency, tenantId)).convertedAmount;
      } catch (error) {
        // No exchange rate on file for this currency yet — skip it rather
        // than fabricate one; the exposure still exists in reality, it's
        // just not quantifiable in base-currency terms until a rate is added.
        continue;
      }
      const varAmount = roundCurrency(baseCurrencyValue * (varPct / 100));

      let fxExp = await TreasuryFXExposureModel.findOne({ tenantId, currency });
      if (!fxExp) {
        fxExp = new TreasuryFXExposureModel({
          tenantId,
          exposureId: this.generateId("TFX"),
          currency,
          baseCurrency,
          longPosition: pos.long,
          shortPosition: pos.short,
          netExposure: net,
          hedgedAmount: 0,
          unhedgedExposure: unhedged,
          exchangeRate,
          baseCurrencyValue,
          varPct,
          varAmount,
          lastUpdated: new Date(),
          updatedBy: userId
        });
      } else {
        fxExp.longPosition = pos.long;
        fxExp.shortPosition = pos.short;
        fxExp.netExposure = net;
        fxExp.unhedgedExposure = unhedged;
        fxExp.exchangeRate = exchangeRate;
        fxExp.baseCurrencyValue = baseCurrencyValue;
        fxExp.varPct = varPct;
        fxExp.varAmount = varAmount;
        fxExp.lastUpdated = new Date();
        fxExp.updatedBy = userId || fxExp.updatedBy;
      }
      await fxExp.save();
      updatedExposures.push(fxExp);
    }

    publishEvent("FXExposureUpdated", {
      tenantId,
      currenciesCount: updatedExposures.length,
      timestamp: new Date()
    });

    return updatedExposures;
  }

  static async getFXExposures({ tenantId }) {
    if (!tenantId) throw new Error("tenantId is required.");
    return await TreasuryFXExposureModel.find({ tenantId }).lean();
  }

  /**
   * Treasury Risk Engine
   */
  static async evaluateTreasuryRisks({ tenantId, userId = null }) {
    if (!tenantId) throw new Error("tenantId is required.");

    const dashboard = await this.getTreasuryDashboard({ tenantId });
    const risksToAssess = [];

    // 1. Liquidity Risk
    const liquidityRatio = dashboard.liquidityRatio;
    const liquidityStatus = liquidityRatio < 1.0 ? "Breached" : (liquidityRatio < 1.5 ? "Warning" : "Normal");
    const liquiditySeverity = liquidityRatio < 1.0 ? "High" : (liquidityRatio < 1.5 ? "Medium" : "Low");

    risksToAssess.push({
      riskType: "LiquidityRisk",
      metricName: "Liquidity Coverage Ratio",
      currentValue: liquidityRatio,
      thresholdValue: 1.5,
      status: liquidityStatus,
      severity: liquiditySeverity,
      mitigationPlan: liquidityRatio < 1.5 ? "Draw down revolving credit facility or sell short-term investments." : "Sufficient liquidity buffer."
    });

    // 2. Counterparty Risk (Bank Concentration)
    const accounts = dashboard.accountSnapshots || [];
    const maxBankBalance = accounts.reduce((max, acc) => Math.max(max, acc.availableBalance || 0), 0);
    const concentrationPct = dashboard.availableCash > 0
      ? Number(((maxBankBalance / dashboard.availableCash) * 100).toFixed(1))
      : 0;

    const counterpartyStatus = concentrationPct > 50 ? "Breached" : (concentrationPct > 40 ? "Warning" : "Normal");
    const counterpartySeverity = concentrationPct > 50 ? "Critical" : (concentrationPct > 40 ? "Medium" : "Low");

    risksToAssess.push({
      riskType: "CounterpartyRisk",
      metricName: "Single Bank Cash Concentration %",
      currentValue: concentrationPct,
      thresholdValue: 40.0,
      status: counterpartyStatus,
      severity: counterpartySeverity,
      mitigationPlan: concentrationPct > 40 ? "Rebalance cash across secondary relationship banks." : "Bank concentration balanced."
    });

    // 3. Currency Risk
    const fxExposureVal = dashboard.fxExposure;
    const fxPctOfCash = dashboard.availableCash > 0
      ? Number(((fxExposureVal / dashboard.availableCash) * 100).toFixed(1))
      : 0;

    const currencyStatus = fxPctOfCash > 20 ? "Warning" : "Normal";
    const currencySeverity = fxPctOfCash > 20 ? "Medium" : "Low";

    risksToAssess.push({
      riskType: "CurrencyRisk",
      metricName: "Unhedged FX Exposure % of Cash",
      currentValue: fxPctOfCash,
      thresholdValue: 20.0,
      status: currencyStatus,
      severity: currencySeverity,
      mitigationPlan: fxPctOfCash > 20 ? "Execute FX forward hedge contracts to reduce exposure." : "Currency risk within bounds."
    });

    // Upsert Risk records
    const evaluatedRisks = [];
    for (const r of risksToAssess) {
      let riskDoc = await TreasuryRiskModel.findOne({ tenantId, riskType: r.riskType });
      if (!riskDoc) {
        riskDoc = new TreasuryRiskModel({
          tenantId,
          riskId: this.generateId("TRK"),
          riskType: r.riskType,
          severity: r.severity,
          metricName: r.metricName,
          currentValue: r.currentValue,
          thresholdValue: r.thresholdValue,
          status: r.status,
          mitigationPlan: r.mitigationPlan,
          detectedAt: new Date()
        });
      } else {
        riskDoc.severity = r.severity;
        riskDoc.metricName = r.metricName;
        riskDoc.currentValue = r.currentValue;
        riskDoc.thresholdValue = r.thresholdValue;
        riskDoc.status = r.status;
        riskDoc.mitigationPlan = r.mitigationPlan;
        riskDoc.detectedAt = new Date();
      }
      await riskDoc.save();
      evaluatedRisks.push(riskDoc);

      if (r.status === "Warning" || r.status === "Breached") {
        publishEvent("TreasuryRiskDetected", {
          tenantId,
          riskId: riskDoc.riskId,
          riskType: riskDoc.riskType,
          severity: riskDoc.severity,
          status: riskDoc.status,
          metricName: riskDoc.metricName,
          currentValue: riskDoc.currentValue,
          thresholdValue: riskDoc.thresholdValue
        });
      }
    }

    return evaluatedRisks;
  }

  static async getTreasuryRisks({ tenantId, status, riskType }) {
    if (!tenantId) throw new Error("tenantId is required.");
    const query = { tenantId };
    if (status) query.status = status;
    if (riskType) query.riskType = riskType;

    return await TreasuryRiskModel.find(query).sort({ severity: -1, status: 1 }).lean();
  }
}

export default TreasuryService;
