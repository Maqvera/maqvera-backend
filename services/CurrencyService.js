import CurrencyModel from "../models/CurrencyModel.js";
import ExchangeRateModel from "../models/ExchangeRateModel.js";
import CurrencyRevaluationModel from "../models/CurrencyRevaluationModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import { isPayableTerminal } from "./AccountsPayableService.js";
import JournalService from "./JournalService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { isValidIso4217Code, ISO_4217_CURRENCIES } from "../utils/iso4217.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value, decimalPlaces = 2) => {
  const factor = 10 ** decimalPlaces;
  return Math.round((Number(value) || 0) * factor) / factor;
};

// A receivable/payable in one of these statuses has no real outstanding
// foreign-currency exposure left to revalue — same terminal sets AR/AP
// already enforce for their own payment allocation gating.
const AR_TERMINAL_STATUSES = new Set(["Paid", "Settled", "Written Off", "Cancelled"]);

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/currencyService.test.js).
// ---------------------------------------------------------------------------

export { isValidIso4217Code };

/** Real MOD-safe rate inversion — never a literal `1 / 0`. */
export const invertRate = (rate) => {
  if (!rate || rate <= 0) throw new Error("Cannot invert a zero or negative rate.");
  return 1 / rate;
};

/**
 * "FX Gain/Loss... Realized Gain, Realized Loss, Unrealized Gain,
 * Unrealized Loss." Revaluation (services/currencyRevaluationScheduler.js)
 * always produces the Unrealized pair — comparing a still-open foreign
 * balance's base-currency value now against its last recorded value.
 * Realized gain/loss is the same math applied at actual settlement
 * instead (the difference between the base-currency amount booked
 * originally and the base-currency amount actually received/paid) — both
 * call this one function; only the caller and what gets written to
 * (CurrencyRevaluationModel vs. an inline settlement record) differ.
 *
 * `isLiability` flips the sign: for an ASSET (bank balance, AR — money
 * owed TO the company), the base-currency value increasing is a GAIN; for
 * a LIABILITY (AP — money the company owes), the base-currency value
 * increasing is a LOSS (it now costs more of the base currency to settle
 * the same foreign-currency obligation).
 */
export const calculateGainLoss = (previousBaseAmount, currentBaseAmount, isLiability = false) => {
  const delta = roundCurrency(currentBaseAmount - previousBaseAmount);
  const signedDelta = isLiability ? -delta : delta;
  if (signedDelta === 0) return { amount: 0, type: null };
  return { amount: Math.abs(signedDelta), type: signedDelta > 0 ? "Unrealized Gain" : "Unrealized Loss" };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CurrencyService {
  // ---- Currencies ----

  /**
   * POST /api/v1/currencies
   * Validate Currency -> Validate ISO Code -> Approval Workflow -> Activate
   * Currency -> Audit -> Publish CurrencyCreated.
   */
  static async createCurrency(data, tenantId, userId) {
    const config = getFinanceConfig();
    const currencyCode = (data.currencyCode || "").toUpperCase().trim();
    if (!isValidIso4217Code(currencyCode)) throw new Error(`"${currencyCode}" is not a recognized ISO 4217 currency code.`);

    const existing = await CurrencyModel.findOne({ tenantId, currencyCode }).lean();
    if (existing) throw new Error(`Currency ${currencyCode} already exists for this tenant.`);

    const reference = ISO_4217_CURRENCIES[currencyCode];
    const name = data.name || reference.name;
    const decimalPlaces = data.decimalPlaces !== undefined && data.decimalPlaces !== null ? data.decimalPlaces : reference.decimalPlaces;
    const isBaseCurrency = !!data.baseCurrency;

    if (isBaseCurrency) {
      await CurrencyModel.updateMany({ tenantId, isBaseCurrency: true }, { $set: { isBaseCurrency: false } });
    }

    const currency = new CurrencyModel({
      tenantId, currencyCode, name, symbol: data.symbol || null, decimalPlaces, isBaseCurrency,
      status: config.defaultCurrencyStatus,
      timeline: [{ event: "CurrencyCreated", description: `Currency ${currencyCode} (${name}) created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (!config.currencyApprovalRequired) {
      currency.status = "Active";
      currency.timeline.push({ event: "CurrencyActivated", description: "Auto-activated — approval is not required.", performedBy: "system" });
    }
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.create", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: { currencyCode, isBaseCurrency } });
    publishEvent("CurrencyCreated", { tenantId, currencyId: currency._id.toString(), currencyCode, isBaseCurrency, performedBy: userId || null });
    if (currency.status === "Active") publishEvent("CurrencyActivated", { tenantId, currencyId: currency._id.toString(), currencyCode, performedBy: "system" });

    return currency.toJSON();
  }

  static async listCurrencies(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    return CurrencyModel.find(filter).sort({ isBaseCurrency: -1, currencyCode: 1 }).lean();
  }

  static async getCurrencyById(currencyId, tenantId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId }).lean();
    if (!currency) throw new Error("Currency not found.");
    return currency;
  }

  static async activateCurrency(currencyId, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.status === "Active") throw new Error("Currency is already Active.");
    if (currency.status === "Archived") throw new Error("Cannot activate an Archived currency.");

    currency.status = "Active";
    currency.updatedBy = userId || null;
    currency.timeline.push({ event: "CurrencyActivated", description: "Currency activated.", performedBy: userId || null });
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.activate", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CurrencyActivated", { tenantId, currencyId: currency._id.toString(), currencyCode: currency.currencyCode, performedBy: userId || null });

    return currency.toJSON();
  }

  static async suspendCurrency(currencyId, data, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.isBaseCurrency) throw new Error("Cannot suspend the tenant's own base currency.");
    if (!["Active", "Draft"].includes(currency.status)) throw new Error(`Cannot suspend a currency in status "${currency.status}".`);

    currency.status = "Suspended";
    currency.updatedBy = userId || null;
    currency.timeline.push({ event: "CurrencySuspended", description: data?.reason || "Currency suspended.", performedBy: userId || null });
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.suspend", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return currency.toJSON();
  }

  static async archiveCurrency(currencyId, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.isBaseCurrency) throw new Error("Cannot archive the tenant's own base currency.");
    if (currency.status === "Archived") throw new Error("Currency is already Archived.");

    currency.status = "Archived";
    currency.updatedBy = userId || null;
    currency.timeline.push({ event: "CurrencyArchived", description: "Currency archived.", performedBy: userId || null });
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.archive", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });

    return currency.toJSON();
  }

  /**
   * "Company Base Currency" — real, tenant-scoped lookup. Falls back to
   * `bookingConfig.defaultCurrency` (uppercased — see the Part 19 fix in
   * utils/financeConfig.js's own doc comment) only when the tenant hasn't
   * explicitly created a base currency yet, the same "unconfigured =
   * sane default" stance used by Financial Periods/Credit Limits.
   */
  static async getBaseCurrency(tenantId) {
    const config = getFinanceConfig();
    const currency = await CurrencyModel.findOne({ tenantId, isBaseCurrency: true }).lean();
    return currency ? currency.currencyCode : config.defaultCurrency;
  }

  static async _getDecimalPlaces(tenantId, currencyCode) {
    const currency = await CurrencyModel.findOne({ tenantId, currencyCode }).lean();
    if (currency) return currency.decimalPlaces;
    return ISO_4217_CURRENCIES[currencyCode]?.decimalPlaces ?? 2;
  }

  // ---- Exchange Rates ----

  /**
   * POST /api/v1/exchange-rates
   * Validate Currency Pair -> Validate Rate -> Store Historical Rate ->
   * Publish ExchangeRateUpdated. Immutable — there is no update/delete;
   * a correction is a new row with a later `effectiveDate`/`createdAt`.
   */
  static async createExchangeRate(data, tenantId, userId) {
    const config = getFinanceConfig();
    const fromCurrency = (data.fromCurrency || "").toUpperCase().trim();
    const toCurrency = (data.toCurrency || "").toUpperCase().trim();
    const { rate, effectiveDate, rateType = config.defaultExchangeRateType, provider = config.defaultRateProvider } = data;

    if (!isValidIso4217Code(fromCurrency) || !isValidIso4217Code(toCurrency)) throw new Error("fromCurrency and toCurrency must be valid ISO 4217 codes.");
    if (fromCurrency === toCurrency) throw new Error("fromCurrency and toCurrency must differ.");
    if (!rate || rate <= 0) throw new Error("rate must be a positive number.");
    if (!effectiveDate) throw new Error("effectiveDate is required.");
    if (!config.exchangeRateTypes.includes(rateType)) throw new Error(`Invalid rateType "${rateType}".`);
    if (!config.rateProviders.includes(provider)) throw new Error(`Invalid provider "${provider}".`);

    const exchangeRate = await ExchangeRateModel.create({
      tenantId, fromCurrency, toCurrency, rate, rateType, provider, source: "Manual", effectiveDate: new Date(effectiveDate), createdBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.currency.create_rate", module: "Finance", resource: "ExchangeRate", resourceId: exchangeRate._id.toString(), userId: userId || null, tenantId, details: { fromCurrency, toCurrency, rate, rateType, provider } });
    publishEvent("ExchangeRateUpdated", { tenantId, exchangeRateId: exchangeRate._id.toString(), fromCurrency, toCurrency, rate, rateType, effectiveDate: exchangeRate.effectiveDate, performedBy: userId || null });

    return exchangeRate.toJSON();
  }

  static async listExchangeRates(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.fromCurrency) filter.fromCurrency = query.fromCurrency.toUpperCase();
    if (query.toCurrency) filter.toCurrency = query.toCurrency.toUpperCase();
    if (query.provider) filter.provider = query.provider;
    if (query.rateType) filter.rateType = query.rateType;
    if (query.effectiveDate) filter.effectiveDate = { $lte: new Date(query.effectiveDate) };

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      ExchangeRateModel.find(filter).sort({ effectiveDate: -1 }).skip(skip).limit(pageSize).lean(),
      ExchangeRateModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * "Automatic Rates... Open Exchange APIs." Real HTTP call (global
   * fetch — Node's own built-in, no SDK needed) against
   * openexchangerates.org's real latest-rates endpoint. Honestly
   * "not configured" (throws, never fabricates a rate) when no app id is
   * set — same discipline as every other external integration this
   * codebase has ever wired (SMTP, gateways, delivery adapters). Only
   * imports rates for currencies the tenant has actually created
   * (real, scoped — not all ~170 codes the provider returns).
   */
  static async importRatesFromProvider(tenantId, userId, data = {}) {
    const config = getFinanceConfig();
    if (!config.openExchangeRatesAppId) throw new Error("Open Exchange Rates is not configured (OPEN_EXCHANGE_RATES_APP_ID is not set).");

    const baseCurrency = (data.baseCurrency || await CurrencyService.getBaseCurrency(tenantId)).toUpperCase();
    const tenantCurrencies = await CurrencyModel.find({ tenantId, status: "Active", currencyCode: { $ne: baseCurrency } }).lean();
    if (tenantCurrencies.length === 0) return { imported: 0, rates: [] };

    const url = `${config.openExchangeRatesBaseUrl.replace(/\/$/, "")}/latest.json?app_id=${config.openExchangeRatesAppId}&base=${baseCurrency}`;
    let payload;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Open Exchange Rates responded with HTTP ${response.status}.`);
      payload = await response.json();
    } catch (error) {
      throw new Error(`Failed to fetch rates from Open Exchange Rates: ${error.message}`);
    }
    if (!payload || typeof payload.rates !== "object") throw new Error("Open Exchange Rates returned an unexpected response shape.");

    const effectiveDate = payload.timestamp ? new Date(payload.timestamp * 1000) : new Date();
    const imported = [];
    for (const currency of tenantCurrencies) {
      const rate = payload.rates[currency.currencyCode];
      if (!rate || rate <= 0) continue;
      const exchangeRate = await ExchangeRateModel.create({
        tenantId, fromCurrency: baseCurrency, toCurrency: currency.currencyCode, rate, rateType: "Spot",
        provider: "OpenExchangeAPI", source: "Automatic", effectiveDate, createdBy: userId || null
      });
      imported.push(exchangeRate.toJSON());
    }

    await AuditLogModel.create({ action: "finance.currency.import_rates", module: "Finance", resource: "ExchangeRate", resourceId: baseCurrency, userId: userId || null, tenantId, details: { baseCurrency, count: imported.length } });
    publishEvent("RateImported", { tenantId, baseCurrency, count: imported.length, provider: "OpenExchangeAPI", effectiveDate, performedBy: userId || null });

    return { imported: imported.length, rates: imported };
  }

  // ---- Conversion Engine ----

  /**
   * The real Conversion Engine. Resolves the best available rate for
   * `fromCurrency` -> `toCurrency` as of `asOfDate` (defaults to now),
   * trying, in order: (1) a direct rate row, (2) the inverse of a stored
   * reverse-pair rate, (3) triangulation through the tenant's own base
   * currency (fromCurrency -> base, then base -> toCurrency) when neither
   * direct pair is on file. Never fabricates a rate — throws when none of
   * the three resolve.
   */
  static async getRate(tenantId, fromCurrency, toCurrency, options = {}) {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();
    const asOfDate = options.asOfDate ? new Date(options.asOfDate) : new Date();
    const rateType = options.rateType || (await CurrencyService._defaultRateType());

    if (from === to) return { rate: 1, rateId: null, rateDate: asOfDate, inverse: false, triangulated: false };

    const direct = await ExchangeRateModel.findOne({ tenantId, fromCurrency: from, toCurrency: to, rateType, effectiveDate: { $lte: asOfDate } }).sort({ effectiveDate: -1 }).lean();
    if (direct) return { rate: direct.rate, rateId: direct._id, rateDate: direct.effectiveDate, inverse: false, triangulated: false };

    const reverse = await ExchangeRateModel.findOne({ tenantId, fromCurrency: to, toCurrency: from, rateType, effectiveDate: { $lte: asOfDate } }).sort({ effectiveDate: -1 }).lean();
    if (reverse) return { rate: invertRate(reverse.rate), rateId: reverse._id, rateDate: reverse.effectiveDate, inverse: true, triangulated: false };

    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    if (baseCurrency !== from && baseCurrency !== to) {
      try {
        const leg1 = await CurrencyService.getRate(tenantId, from, baseCurrency, { asOfDate, rateType });
        const leg2 = await CurrencyService.getRate(tenantId, baseCurrency, to, { asOfDate, rateType });
        return { rate: roundCurrency(leg1.rate * leg2.rate, 8), rateId: null, rateDate: asOfDate, inverse: false, triangulated: true };
      } catch {
        // Fall through to the final "no rate available" error below —
        // triangulation is a best-effort third option, not a guarantee.
      }
    }

    throw new Error(`No exchange rate available for ${from} -> ${to} as of ${asOfDate.toISOString().slice(0, 10)}.`);
  }

  static async _defaultRateType() {
    return getFinanceConfig().defaultExchangeRateType;
  }

  /** Converts `amount` from `fromCurrency` to `toCurrency`, rounded to the target currency's own real decimal places. */
  static async convert(amount, fromCurrency, toCurrency, tenantId, options = {}) {
    const { rate, rateId, rateDate, inverse, triangulated } = await CurrencyService.getRate(tenantId, fromCurrency, toCurrency, options);
    const decimalPlaces = await CurrencyService._getDecimalPlaces(tenantId, toCurrency.toUpperCase());
    const convertedAmount = roundCurrency(amount * rate, decimalPlaces);
    return { convertedAmount, rate, rateId, rateDate, inverse, triangulated };
  }

  // ---- Revaluation & FX Gain/Loss ----

  static async _postAutomaticJournal({ tenantId, userId, postingDate, description, currency, referenceNumber, lines }) {
    const journal = await JournalService.createJournal({ journalType: "Automatic", postingDate, description, referenceNumber, currency, lines }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    return JournalService.postJournal(journal._id, tenantId, userId || "system");
  }

  /**
   * Revalues a single open foreign-currency balance. Reads the live
   * balance directly off the target's own already-shipped model — no
   * schema changes to BankAccountModel/AccountsReceivableModel/
   * AccountsPayableModel were needed. `previousBaseAmount` is the last
   * revaluation's own `currentBaseAmount` for this exact record when one
   * exists (a real rolling period-over-period baseline); otherwise it's
   * this same conversion performed as of the record's own `bookingDate`
   * (its creation date) — the first-ever revaluation's honest baseline.
   */
  static async revalueRecord({ targetType, targetId, currency, foreignAmount, controlAccountCode, bookingDate, tenantId, revaluationDate, userId }) {
    const config = getFinanceConfig();
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    if (currency.toUpperCase() === baseCurrency) return null; // Nothing to revalue — already in base currency.

    const asOfDate = revaluationDate || new Date();
    const { convertedAmount: currentBaseAmount, rate, rateId } = await CurrencyService.convert(foreignAmount, currency, baseCurrency, tenantId, { asOfDate });

    const previous = await CurrencyRevaluationModel.findOne({ tenantId, targetType, targetId }).sort({ revaluationDate: -1 }).lean();
    let previousBaseAmount;
    if (previous) {
      previousBaseAmount = previous.currentBaseAmount;
    } else {
      const baseline = await CurrencyService.convert(foreignAmount, currency, baseCurrency, tenantId, { asOfDate: bookingDate || asOfDate });
      previousBaseAmount = baseline.convertedAmount;
    }

    const isLiability = targetType === "AccountsPayable";
    const { amount: gainLossAmount, type: gainLossType } = calculateGainLoss(previousBaseAmount, currentBaseAmount, isLiability);

    let journalId = null;
    if (gainLossAmount > 0 && config.fxGainAccountCode && config.fxLossAccountCode && controlAccountCode) {
      const isGain = gainLossType === "Unrealized Gain";
      // A gain increases the asset's/decreases the liability's own control
      // account balance; a loss does the reverse — the fxGain/fxLoss
      // account is always the offsetting side.
      const controlIsDebit = (isGain && !isLiability) || (!isGain && isLiability);
      const lines = controlIsDebit
        ? [{ accountCode: controlAccountCode, debit: gainLossAmount }, { accountCode: isGain ? config.fxGainAccountCode : config.fxLossAccountCode, credit: gainLossAmount }]
        : [{ accountCode: isGain ? config.fxGainAccountCode : config.fxLossAccountCode, debit: gainLossAmount }, { accountCode: controlAccountCode, credit: gainLossAmount }];

      const journal = await CurrencyService._postAutomaticJournal({
        tenantId, userId, postingDate: asOfDate, description: `FX ${gainLossType} on ${targetType} ${targetId}`, currency: baseCurrency, referenceNumber: targetId.toString(), lines
      });
      journalId = journal?._id || null;
    }

    const revaluation = await CurrencyRevaluationModel.create({
      tenantId, revaluationDate: asOfDate, targetType, targetId, currencyCode: currency.toUpperCase(), baseCurrencyCode: baseCurrency,
      foreignAmount, previousBaseAmount, currentBaseAmount, rateUsed: rate, rateId, gainLossAmount, gainLossType, journalId, performedBy: userId || "system"
    });

    await AuditLogModel.create({ action: "finance.currency.revalue", module: "Finance", resource: targetType, resourceId: targetId.toString(), userId: userId || null, tenantId, details: { gainLossAmount, gainLossType, rate } });
    publishEvent("CurrencyRevalued", { tenantId, targetType, targetId: targetId.toString(), currencyCode: currency.toUpperCase(), gainLossAmount, gainLossType, performedBy: userId || "system" });
    if (gainLossType === "Unrealized Gain") publishEvent("FXGainCalculated", { tenantId, targetType, targetId: targetId.toString(), amount: gainLossAmount, performedBy: userId || "system" });
    if (gainLossType === "Unrealized Loss") publishEvent("FXLossCalculated", { tenantId, targetType, targetId: targetId.toString(), amount: gainLossAmount, performedBy: userId || "system" });

    return revaluation.toJSON();
  }

  /**
   * "Automatic period-end revaluation." Walks every real open
   * foreign-currency exposure across the three real targets
   * (fxRevaluationTargets) for one tenant and revalues each — called by
   * services/currencyRevaluationScheduler.js on its own cron, or directly
   * via POST /api/v1/currencies/revalue for an on-demand run.
   */
  static async runPeriodEndRevaluation(tenantId, userId, revaluationDate = new Date()) {
    const config = getFinanceConfig();
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    const results = [];

    if (config.fxRevaluationTargets.includes("BankAccount")) {
      const bankAccounts = await BankAccountModel.find({ tenantId, status: { $in: ["Active", "Verified"] }, currency: { $ne: baseCurrency } }).lean();
      for (const account of bankAccounts) {
        if (!account.balances?.current) continue;
        const result = await CurrencyService.revalueRecord({
          targetType: "BankAccount", targetId: account._id, currency: account.currency, foreignAmount: account.balances.current,
          controlAccountCode: account.glAccountCode, bookingDate: account.createdAt, tenantId, revaluationDate, userId
        });
        if (result) results.push(result);
      }
    }

    if (config.fxRevaluationTargets.includes("AccountsReceivable")) {
      const receivables = await AccountsReceivableModel.find({ tenantId, status: { $nin: [...AR_TERMINAL_STATUSES] }, currency: { $ne: baseCurrency }, outstandingBalance: { $gt: 0 } }).lean();
      for (const receivable of receivables) {
        const result = await CurrencyService.revalueRecord({
          targetType: "AccountsReceivable", targetId: receivable._id, currency: receivable.currency, foreignAmount: receivable.outstandingBalance,
          controlAccountCode: config.arControlAccountCode, bookingDate: receivable.createdAt, tenantId, revaluationDate, userId
        });
        if (result) results.push(result);
      }
    }

    if (config.fxRevaluationTargets.includes("AccountsPayable")) {
      const payables = await AccountsPayableModel.find({ tenantId, currency: { $ne: baseCurrency }, outstandingBalance: { $gt: 0 } }).lean();
      for (const payable of payables) {
        if (isPayableTerminal(payable.status)) continue;
        const result = await CurrencyService.revalueRecord({
          targetType: "AccountsPayable", targetId: payable._id, currency: payable.currency, foreignAmount: payable.outstandingBalance,
          controlAccountCode: config.apControlAccountCode, bookingDate: payable.createdAt, tenantId, revaluationDate, userId
        });
        if (result) results.push(result);
      }
    }

    const totalGain = roundCurrency(results.filter((r) => r.gainLossType === "Unrealized Gain").reduce((sum, r) => sum + r.gainLossAmount, 0));
    const totalLoss = roundCurrency(results.filter((r) => r.gainLossType === "Unrealized Loss").reduce((sum, r) => sum + r.gainLossAmount, 0));

    return { revalued: results.length, totalGain, totalLoss, baseCurrency, results };
  }

  static async listRevaluations(query, tenantId) {
    const filter = { tenantId };
    if (query.targetType) filter.targetType = query.targetType;
    return CurrencyRevaluationModel.find(filter).sort({ revaluationDate: -1 }).limit(200).lean();
  }

  // ---- Multi-Currency Reporting ----

  /**
   * "Multi-Currency Reporting... Consolidated Reports." A real, live FX
   * exposure snapshot — every open foreign-currency balance across the
   * three real targets, grouped by currency, converted to base currency
   * at today's rate. Not a stored report; computed fresh from live data
   * every call, same as Vendor Payment's own suggestPaymentTiming.
   */
  static async getCurrencyExposure(tenantId) {
    const config = getFinanceConfig();
    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);

    const [bankAccounts, receivables, payables] = await Promise.all([
      BankAccountModel.find({ tenantId, status: { $in: ["Active", "Verified"] }, currency: { $ne: baseCurrency } }).select("currency balances.current").lean(),
      AccountsReceivableModel.find({ tenantId, status: { $nin: [...AR_TERMINAL_STATUSES] }, currency: { $ne: baseCurrency } }).select("currency outstandingBalance").lean(),
      AccountsPayableModel.find({ tenantId, currency: { $ne: baseCurrency } }).select("currency outstandingBalance status").lean()
    ]);

    const byCurrency = new Map();
    const add = (currency, field, amount) => {
      if (!amount) return;
      if (!byCurrency.has(currency)) byCurrency.set(currency, { currencyCode: currency, bankBalance: 0, receivableBalance: 0, payableBalance: 0 });
      byCurrency.get(currency)[field] += amount;
    };

    for (const account of bankAccounts) add(account.currency, "bankBalance", account.balances?.current || 0);
    for (const receivable of receivables) add(receivable.currency, "receivableBalance", receivable.outstandingBalance);
    for (const payable of payables) {
      if (isPayableTerminal(payable.status)) continue;
      add(payable.currency, "payableBalance", payable.outstandingBalance);
    }

    const exposure = [];
    for (const entry of byCurrency.values()) {
      const netForeign = roundCurrency(entry.bankBalance + entry.receivableBalance - entry.payableBalance);
      let baseEquivalent = null;
      try {
        baseEquivalent = (await CurrencyService.convert(netForeign, entry.currencyCode, baseCurrency, tenantId)).convertedAmount;
      } catch {
        baseEquivalent = null; // No rate on file yet — reported as null, never fabricated.
      }
      exposure.push({ ...entry, netForeign, baseEquivalent });
    }

    return { baseCurrency, exposure };
  }
}

export default CurrencyService;
