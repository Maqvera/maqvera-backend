import CurrencyModel from "../models/CurrencyModel.js";
import ExchangeRateModel from "../models/ExchangeRateModel.js";
import CurrencyRevaluationModel from "../models/CurrencyRevaluationModel.js";
import CurrencyConversionModel from "../models/CurrencyConversionModel.js";
import BankAccountModel from "../models/BankAccountModel.js";
import AccountsReceivableModel from "../models/AccountsReceivableModel.js";
import AccountsPayableModel from "../models/AccountsPayableModel.js";
import TreasuryInvestmentModel from "../models/TreasuryInvestmentModel.js";
import CashLocationModel from "../models/CashLocationModel.js";
import TreasuryDebtModel from "../models/TreasuryDebtModel.js";
import { isPayableTerminal } from "./AccountsPayableService.js";
import JournalService from "./JournalService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { isValidIso4217Code, isValidIso4217NumericCode, ISO_4217_CURRENCIES } from "../utils/iso4217.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import CacheManager from "../utils/cacheManager.js";
import logger from "../utils/logger.js";

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
/**
 * `realized` (File 4 Part 3 — "Realized FX Gain, Realized FX Loss") picks
 * which of the two real, otherwise-identical label pairs to return —
 * Unrealized (period-end revaluation, `revalueRecord`) vs. Realized (at
 * actual settlement, `AccountsReceivableService`/`AccountsPayableService`
 * `allocatePayment`). Same underlying math both times; only the label and
 * WHERE the comparison amounts came from differ.
 */
export const calculateGainLoss = (previousBaseAmount, currentBaseAmount, isLiability = false, realized = false) => {
  const delta = roundCurrency(currentBaseAmount - previousBaseAmount);
  const signedDelta = isLiability ? -delta : delta;
  if (signedDelta === 0) return { amount: 0, type: null };
  const label = realized ? "Realized" : "Unrealized";
  return { amount: Math.abs(signedDelta), type: signedDelta > 0 ? `${label} Gain` : `${label} Loss` };
};

/**
 * "Currency Rounding Rules... Banker's Rounding, Commercial Rounding,
 * Always Up, Always Down." Applied only at the Conversion Engine's own
 * final output rounding (`convert()` below) — every other `roundCurrency`
 * call in this codebase's internal ledger/accounting math is deliberately
 * untouched (plain commercial round-half-up), so this never destabilizes
 * arithmetic no caller asked to make configurable.
 */
export const roundWithMode = (value, decimalPlaces, mode = "Commercial") => {
  const factor = 10 ** decimalPlaces;
  const scaled = (Number(value) || 0) * factor;
  if (mode === "AlwaysUp") return Math.ceil(scaled) / factor;
  if (mode === "AlwaysDown") return Math.floor(scaled) / factor;
  if (mode === "BankersRounding") {
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    if (Math.abs(diff - 0.5) < 1e-9) return (floor % 2 === 0 ? floor : floor + 1) / factor;
    return Math.round(scaled) / factor;
  }
  return Math.round(scaled) / factor; // Commercial — unchanged existing behavior.
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class CurrencyService {
  // ---- Currencies ----

  /** Real, shared status transition — bumps `version`, appends `timeline`, sets `updatedBy`. Every Currency lifecycle method below goes through this one place. */
  static _transitionCurrencyStatus(currency, status, event, description, userId) {
    currency.status = status;
    currency.version = (currency.version || 1) + 1;
    currency.updatedBy = userId || null;
    currency.timeline.push({ event, description, performedBy: userId || null });
  }

  /**
   * POST /api/v1/currencies — File 4 Part 2 (API Contracts Refactoring).
   * Validate Currency -> Validate ISO Code -> Validate Precision ->
   * Validate Duplicate -> Approval Workflow -> Activate Currency -> Audit
   * -> Publish CurrencyCreated. When `currencyApprovalRequired` is false
   * (default), creation auto-walks Draft -> Pending Approval -> Approved
   * -> Active in this one call — the exact same real end state this
   * endpoint has always produced, now recording the real intermediate
   * transitions on `timeline` instead of a single status jump. When true,
   * creation stops at Draft and the caller must walk
   * `submitCurrencyForApproval` -> `approveCurrencyDefinition` ->
   * `activateCurrency` explicitly.
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
    if (decimalPlaces < 0 || decimalPlaces > 4) throw new Error("decimalPlaces must be between 0 and 4.");

    // "ISO Numeric Exists" — real cross-validation against
    // utils/iso4217.js's own reference table, not merely a 3-digit format
    // check.
    let isoNumericCode = data.isoNumericCode ? String(data.isoNumericCode).trim() : null;
    if (isoNumericCode) {
      if (!isValidIso4217NumericCode(isoNumericCode)) throw new Error(`"${isoNumericCode}" is not a valid ISO 4217 numeric code (must be 3 digits).`);
      if (reference.numericCode && isoNumericCode !== reference.numericCode) {
        throw new Error(`Invalid ISO numeric code "${isoNumericCode}" — does not match the real ISO 4217 numeric code for ${currencyCode} ("${reference.numericCode}").`);
      }
    } else {
      isoNumericCode = reference.numericCode || null;
    }

    const currencyType = data.currencyType || config.defaultCurrencyType;
    if (!config.currencyTypes.includes(currencyType)) throw new Error(`Invalid currencyType "${currencyType}".`);

    const isBaseCurrency = !!data.baseCurrency;
    const isReportingCurrency = !!data.reportingCurrency;

    if (isBaseCurrency) {
      // Base Currency stays strictly single — every real resolution
      // (getBaseCurrency, revaluation, conversion) assumes exactly one;
      // loosening this is a genuine architectural decision, not revisited
      // here (see this Part's own doc section).
      await CurrencyModel.updateMany({ tenantId, isBaseCurrency: true }, { $set: { isBaseCurrency: false } });
      await CacheManager.invalidate(`currency:base:${tenantId}`);
    }
    // "Multiple reporting currencies are supported simultaneously" (File 7
    // Part 4) — unlike Base Currency, nothing downstream resolves "the"
    // single reporting currency yet (FinancialReportService has no
    // currency-translation parameter at all — see this Part's own doc
    // section), so there is no real single-value assumption to protect;
    // no longer unsets a prior holder.

    const currency = new CurrencyModel({
      tenantId, currencyCode, name, symbol: data.symbol || null, decimalPlaces, isoNumericCode, currencyType, isBaseCurrency, isReportingCurrency,
      status: "Draft", version: 1,
      timeline: [{ event: "CurrencyCreated", description: `Currency ${currencyCode} (${name}) created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (!config.currencyApprovalRequired) {
      CurrencyService._transitionCurrencyStatus(currency, "Pending Approval", "CurrencySubmittedForApproval", "Auto-submitted — approval is not required.", "system");
      currency.approvedBy = "system";
      currency.approvedAt = new Date();
      CurrencyService._transitionCurrencyStatus(currency, "Approved", "CurrencyApproved", "Auto-approved — approval is not required.", "system");
      CurrencyService._transitionCurrencyStatus(currency, "Active", "CurrencyActivated", "Auto-activated — approval is not required.", "system");
    }
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.create", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: { currencyCode, isBaseCurrency, isReportingCurrency, currencyType } });
    publishEvent("CurrencyCreated", { tenantId, currencyId: currency._id.toString(), currencyCode, isBaseCurrency, isReportingCurrency, currencyType, performedBy: userId || null });
    if (currency.status === "Active") publishEvent("CurrencyActivated", { tenantId, currencyId: currency._id.toString(), currencyCode, performedBy: "system" });

    return currency.toJSON();
  }

  /** POST /api/v1/currencies/{currencyId}/submit — Draft -> Pending Approval. */
  static async submitCurrencyForApproval(currencyId, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.status !== "Draft") throw new Error(`Cannot submit a currency for approval from status "${currency.status}".`);

    CurrencyService._transitionCurrencyStatus(currency, "Pending Approval", "CurrencySubmittedForApproval", "Submitted for approval.", userId);
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.submit", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });

    return currency.toJSON();
  }

  /** POST /api/v1/currencies/{currencyId}/approve — Pending Approval -> Approved. Same single configurable gate as Journal's/Invoice's own — see utils/financeConfig.js's own doc comment on `currencyApprovalRequired`. */
  static async approveCurrencyDefinition(currencyId, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.status !== "Pending Approval") throw new Error(`Cannot approve a currency from status "${currency.status}".`);

    currency.approvedBy = userId || null;
    currency.approvedAt = new Date();
    CurrencyService._transitionCurrencyStatus(currency, "Approved", "CurrencyApproved", "Approved.", userId);
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.approve", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CurrencyApproved", { tenantId, currencyId: currency._id.toString(), currencyCode: currency.currencyCode, performedBy: userId || null });

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

  /**
   * POST /api/v1/currencies/{currencyId}/activate — from Suspended
   * (reactivation, unchanged legacy behavior, real regardless of the
   * approval gate) or Approved (the new gated path). From Draft: allowed
   * ONLY when `currencyApprovalRequired` is false — otherwise a direct
   * Draft -> Active call would silently bypass the entire approval gate
   * this Part exists to enforce, so it's blocked exactly like Pending
   * Approval/Archived/Deprecated are.
   */
  static async activateCurrency(currencyId, tenantId, userId) {
    const config = getFinanceConfig();
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.status === "Active") throw new Error("Currency is already Active.");
    if (["Archived", "Pending Approval", "Deprecated"].includes(currency.status)) throw new Error(`Cannot activate a currency in status "${currency.status}".`);
    if (currency.status === "Draft" && config.currencyApprovalRequired) throw new Error("Cannot activate a currency directly from Draft while approval is required — submit it for approval first.");

    CurrencyService._transitionCurrencyStatus(currency, "Active", "CurrencyActivated", "Currency activated.", userId);
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.activate", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CurrencyActivated", { tenantId, currencyId: currency._id.toString(), currencyCode: currency.currencyCode, performedBy: userId || null });

    return currency.toJSON();
  }

  static async suspendCurrency(currencyId, data, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.isBaseCurrency) throw new Error("Cannot suspend the tenant's own base currency.");
    if (!["Active", "Draft", "Pending Approval", "Approved"].includes(currency.status)) throw new Error(`Cannot suspend a currency in status "${currency.status}".`);

    CurrencyService._transitionCurrencyStatus(currency, "Suspended", "CurrencySuspended", data?.reason || "Currency suspended.", userId);
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.suspend", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    // Gap-fill (File 7) — every other lifecycle transition already
    // publishes its own real domain event; Suspend/Archive were the two
    // that only ever wrote a timeline entry.
    publishEvent("CurrencySuspended", { tenantId, currencyId: currency._id.toString(), currencyCode: currency.currencyCode, reason: data?.reason || null, performedBy: userId || null });

    return currency.toJSON();
  }

  static async archiveCurrency(currencyId, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.isBaseCurrency) throw new Error("Cannot archive the tenant's own base currency.");
    if (currency.status === "Archived") throw new Error("Currency is already Archived.");

    CurrencyService._transitionCurrencyStatus(currency, "Archived", "CurrencyArchived", "Currency archived.", userId);
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.archive", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CurrencyArchived", { tenantId, currencyId: currency._id.toString(), currencyCode: currency.currencyCode, performedBy: userId || null });

    return currency.toJSON();
  }

  /**
   * POST /api/v1/currencies/{currencyId}/deprecate — genuinely distinct
   * from Archive: a Deprecated currency remains valid for reading
   * historical transactions already posted in it (nothing about existing
   * `ExchangeRateModel`/ledger rows changes), it is simply rejected for
   * any NEW transaction going forward. Only a real, currently-Active
   * currency can be deprecated.
   */
  static async deprecateCurrency(currencyId, tenantId, userId) {
    const currency = await CurrencyModel.findOne({ _id: currencyId, tenantId });
    if (!currency) throw new Error("Currency not found.");
    if (currency.isBaseCurrency) throw new Error("Cannot deprecate the tenant's own base currency.");
    if (currency.status !== "Active") throw new Error(`Cannot deprecate a currency that is not Active (status "${currency.status}").`);

    CurrencyService._transitionCurrencyStatus(currency, "Deprecated", "CurrencyDeprecated", "Currency deprecated — no longer available for new transactions.", userId);
    await currency.save();

    await AuditLogModel.create({ action: "finance.currency.deprecate", module: "Finance", resource: "Currency", resourceId: currency._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("CurrencyDeprecated", { tenantId, currencyId: currency._id.toString(), currencyCode: currency.currencyCode, performedBy: userId || null });

    return currency.toJSON();
  }

  /**
   * "Company Base Currency" — real, tenant-scoped lookup. Falls back to
   * `bookingConfig.defaultCurrency` (uppercased — see the Part 19 fix in
   * utils/financeConfig.js's own doc comment) only when the tenant hasn't
   * explicitly created a base currency yet, the same "unconfigured =
   * sane default" stance used by Financial Periods/Credit Limits.
   */
  /**
   * "Performance... Cache Layer... Caches Currency Rules. Short-lived
   * cache only. Financial transactions are never cached." (Part 18 Part
   * 5.) This is the one real, safe, high-value cache target in this Part
   * — a plain currency-code string with zero serialization risk (unlike
   * a full exchange-rate lookup, which carries a Date/ObjectId that a
   * real Redis backend would round-trip through JSON and subtly change
   * the shape of — not worth the risk for a config value this cheap to
   * keep looking up directly). Invalidated explicitly on the one real
   * mutation that can change it (`createCurrency` setting a new base
   * currency), not left to expire silently and serve a stale value.
   */
  static async getBaseCurrency(tenantId) {
    const config = getFinanceConfig();
    const { data } = await CacheManager.getOrCompute(`currency:base:${tenantId}`, async () => {
      const currency = await CurrencyModel.findOne({ tenantId, isBaseCurrency: true }).lean();
      return currency ? currency.currencyCode : config.defaultCurrency;
    }, 300);
    return data;
  }

  /**
   * "Caching Strategy... Currency Metadata." (File 7 Part 5) — same real
   * `CacheManager.getOrCompute` pattern `getBaseCurrency` already proves,
   * over the one Currency Metadata lookup actually on a hot path (every
   * single `convert()` call). No explicit invalidation wired — this
   * codebase has no update-decimalPlaces endpoint (only `createCurrency`
   * ever sets it), so a short TTL alone is correct, not a gap.
   */
  static async _getDecimalPlaces(tenantId, currencyCode) {
    const { data } = await CacheManager.getOrCompute(`currency:decimals:${tenantId}:${currencyCode}`, async () => {
      const currency = await CurrencyModel.findOne({ tenantId, currencyCode }).lean();
      if (currency) return currency.decimalPlaces;
      return ISO_4217_CURRENCIES[currencyCode]?.decimalPlaces ?? 2;
    }, 300);
    return data;
  }

  // ---- Exchange Rates ----

  /** Real, shared activation — sets `approvalStatus: "Activated"`, and — if this row was created to replace a prior current one (`supersedes`) — flips that OLD row to "Superseded" (never edited/deleted otherwise). Used by both the immediate-activation path (`createExchangeRate` when no approval is required) and the explicit `approveExchangeRate` endpoint. */
  static async _activateExchangeRateRow(exchangeRate, userId) {
    exchangeRate.approvalStatus = "Activated";
    exchangeRate.approvedBy = userId || "system";
    exchangeRate.approvedAt = new Date();
    await exchangeRate.save();

    if (exchangeRate.supersedes) {
      await ExchangeRateModel.updateOne({ _id: exchangeRate.supersedes }, { $set: { approvalStatus: "Superseded", supersededBy: exchangeRate._id } });
    }
  }

  /**
   * POST /api/v1/exchange-rates — File 4 Part 2. Validate Provider ->
   * Validate Currency Pair -> Validate Rate -> Check Effective Date ->
   * Store New Version -> Preserve Historical Version -> Approval Workflow
   * (Optional) -> Activate Rate -> Publish ExchangeRateUpdated -> Audit.
   * Immutable — there is no update/delete; every call is a genuinely new
   * row. "No Overlapping Active Version" — the previously-current
   * Activated row for this exact (fromCurrency, toCurrency, rateType) is
   * linked via `supersedes` at creation and flipped to "Superseded" the
   * moment this new row actually activates (immediately here when
   * `exchangeRateApprovalRequired` is false, or later via
   * `approveExchangeRate` when it's true) — never before, since an
   * unapproved row must never suppress the still-current approved one.
   */
  static async createExchangeRate(data, tenantId, userId, correlationId = null) {
    const config = getFinanceConfig();
    const fromCurrency = (data.fromCurrency || "").toUpperCase().trim();
    const toCurrency = (data.toCurrency || "").toUpperCase().trim();
    const { rate, effectiveDate, expiresAt = null, rateType = config.defaultExchangeRateType, provider = config.defaultRateProvider } = data;

    if (!isValidIso4217Code(fromCurrency) || !isValidIso4217Code(toCurrency)) throw new Error("fromCurrency and toCurrency must be valid ISO 4217 codes.");
    if (fromCurrency === toCurrency) throw new Error("fromCurrency and toCurrency must differ.");
    // "Source Currency Exists" / "Target Currency Exists" — File 7 Part 2.
    // A syntactically valid ISO 4217 code isn't enough; the tenant must
    // have actually registered the currency via POST /currencies first
    // (previously unchecked — any ISO code could get a rate recorded
    // against it even if the tenant never onboarded that currency).
    const [fromRegistered, toRegistered] = await Promise.all([
      CurrencyModel.exists({ tenantId, currencyCode: fromCurrency }),
      CurrencyModel.exists({ tenantId, currencyCode: toCurrency })
    ]);
    if (!fromRegistered) throw new Error(`Source currency "${fromCurrency}" is not registered for this tenant — create it via POST /currencies first.`);
    if (!toRegistered) throw new Error(`Target currency "${toCurrency}" is not registered for this tenant — create it via POST /currencies first.`);
    if (!rate || rate <= 0) throw new Error("rate must be a positive number.");
    if (!effectiveDate) throw new Error("effectiveDate is required.");
    if (!config.exchangeRateTypes.includes(rateType)) throw new Error(`Invalid rateType "${rateType}".`);
    if (!config.rateProviders.includes(provider)) throw new Error(`Invalid provider "${provider}".`);

    const effectiveDateObj = new Date(effectiveDate);
    const expiresAtObj = expiresAt ? new Date(expiresAt) : null;
    if (expiresAtObj && expiresAtObj <= effectiveDateObj) throw new Error("expiresAt must be after effectiveDate.");

    const previousActive = await ExchangeRateModel.findOne({
      tenantId, fromCurrency, toCurrency, rateType,
      $or: [{ approvalStatus: "Activated" }, { approvalStatus: null }, { approvalStatus: { $exists: false } }]
    }).sort({ version: -1, effectiveDate: -1 });
    const version = previousActive ? (previousActive.version || 1) + 1 : 1;

    const exchangeRate = await ExchangeRateModel.create({
      tenantId, fromCurrency, toCurrency, rate, rateType, provider, source: "Manual", effectiveDate: effectiveDateObj, expiresAt: expiresAtObj,
      version, approvalStatus: "Pending Approval", supersedes: previousActive?._id || null, correlationId, createdBy: userId || null
    });

    if (!config.exchangeRateApprovalRequired) {
      await CurrencyService._activateExchangeRateRow(exchangeRate, userId);
    }

    await AuditLogModel.create({ action: "finance.currency.create_rate", module: "Finance", resource: "ExchangeRate", resourceId: exchangeRate._id.toString(), userId: userId || null, tenantId, details: { fromCurrency, toCurrency, rate, rateType, provider, version, approvalStatus: exchangeRate.approvalStatus } });
    publishEvent("ExchangeRateUpdated", { tenantId, exchangeRateId: exchangeRate._id.toString(), fromCurrency, toCurrency, rate, rateType, effectiveDate: exchangeRate.effectiveDate, version, approvalStatus: exchangeRate.approvalStatus, correlationId, performedBy: userId || null });

    return exchangeRate.toJSON();
  }

  /** POST /api/v1/exchange-rates/{exchangeRateId}/approve — Pending Approval -> Activated. Same single configurable gate as Currency's own — "Finance Review -> Treasury Review" collapses into this one real approval action (no concrete multi-tier policy was given to build a real policy engine against). */
  static async approveExchangeRate(exchangeRateId, tenantId, userId) {
    const exchangeRate = await ExchangeRateModel.findOne({ _id: exchangeRateId, tenantId });
    if (!exchangeRate) throw new Error("Exchange rate not found.");
    if (exchangeRate.approvalStatus !== "Pending Approval") throw new Error(`Cannot approve an exchange rate in status "${exchangeRate.approvalStatus}".`);

    await CurrencyService._activateExchangeRateRow(exchangeRate, userId);

    await AuditLogModel.create({ action: "finance.currency.approve_rate", module: "Finance", resource: "ExchangeRate", resourceId: exchangeRate._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("ExchangeRateUpdated", { tenantId, exchangeRateId: exchangeRate._id.toString(), fromCurrency: exchangeRate.fromCurrency, toCurrency: exchangeRate.toCurrency, rate: exchangeRate.rate, version: exchangeRate.version, approvalStatus: "Activated", performedBy: userId || null });

    return exchangeRate.toJSON();
  }

  static async rejectExchangeRate(exchangeRateId, data, tenantId, userId) {
    const exchangeRate = await ExchangeRateModel.findOne({ _id: exchangeRateId, tenantId });
    if (!exchangeRate) throw new Error("Exchange rate not found.");
    if (exchangeRate.approvalStatus !== "Pending Approval") throw new Error(`Cannot reject an exchange rate in status "${exchangeRate.approvalStatus}".`);

    exchangeRate.approvalStatus = "Rejected";
    await exchangeRate.save();

    await AuditLogModel.create({ action: "finance.currency.reject_rate", module: "Finance", resource: "ExchangeRate", resourceId: exchangeRate._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return exchangeRate.toJSON();
  }

  /**
   * GET /api/v1/exchange-rates — File 4 Part 2. Adds `status`
   * (approvalStatus)/`version` filters, friendly `sort` aliases, and an
   * opt-in `cursor` pagination mode alongside the pre-existing `page`/
   * `pageSize` offset pagination (omitting `cursor` keeps prior behavior
   * exactly) — same pattern already proven on Part 18's own
   * `GET /customer-payments`. `tenant`/`company`/`branch` from the spec
   * are never accepted as filters — tenant identity only ever comes from
   * `getAccessScope(req)`, and there is no Company/Branch isolation
   * dimension in this codebase at all.
   */
  static async listExchangeRates(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.fromCurrency) filter.fromCurrency = query.fromCurrency.toUpperCase();
    if (query.toCurrency) filter.toCurrency = query.toCurrency.toUpperCase();
    if (query.provider) filter.provider = query.provider;
    if (query.rateType) filter.rateType = query.rateType;
    if (query.status) filter.approvalStatus = query.status;
    if (query.version) filter.version = parseInt(query.version, 10);
    if (query.effectiveDate) filter.effectiveDate = { $lte: new Date(query.effectiveDate) };

    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);

    // "Sorting... Newest, Oldest, Highest Rate, Lowest Rate, Provider,
    // Effective Date, Created Date, Version, Custom Sort."
    const SORT_ALIASES = {
      newest: "-effectiveDate", oldest: "effectiveDate",
      "highest rate": "-rate", "lowest rate": "rate",
      provider: "provider", "effective date": "-effectiveDate", "created date": "-createdAt", version: "-version"
    };
    const rawSort = query.sort ? (SORT_ALIASES[query.sort.toLowerCase()] || query.sort) : "-effectiveDate";
    const direction = rawSort.startsWith("-") ? -1 : 1;
    const sortField = rawSort.replace(/^-/, "");
    const sortSpec = { [sortField]: direction };

    let items; let pagination;
    if (query.cursor) {
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(query.cursor, "base64").toString("utf8"));
      } catch (error) {
        throw new Error("Invalid cursor.");
      }
      const cmp = direction === -1 ? "$lt" : "$gt";
      Object.assign(filter, {
        $and: [
          ...(filter.$and || []),
          { $or: [{ [sortField]: { [cmp]: decoded.lastValue } }, { [sortField]: decoded.lastValue, _id: { [cmp]: decoded.lastId } }] }
        ]
      });
      items = await ExchangeRateModel.find(filter).sort({ ...sortSpec, _id: direction }).limit(pageSize).lean();
      let nextCursor = null;
      if (items.length === pageSize) {
        const last = items[items.length - 1];
        nextCursor = Buffer.from(JSON.stringify({ lastValue: last[sortField], lastId: last._id })).toString("base64");
      }
      pagination = { mode: "cursor", pageSize, nextCursor };
    } else {
      const page = Math.max(parseInt(query.page, 10) || 1, 1);
      const skip = (page - 1) * pageSize;
      let total;
      [items, total] = await Promise.all([
        ExchangeRateModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
        ExchangeRateModel.countDocuments(filter)
      ]);
      pagination = { mode: "offset", total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    }

    return { items, pagination };
  }

  /**
   * GET /api/v1/exchange-rates/{rateId} — File 7 Part 2. Real "Rate
   * Details" (the row itself), "Historical Versions" (every row this
   * exact currency-pair/rateType family has ever had, oldest to newest —
   * the same `supersedes`/`supersededBy` chain `createExchangeRate`
   * already builds, walked forward via a plain query rather than
   * re-deriving it), "Provider" (the row's own field), "Audit History"
   * (real `AuditLogModel` rows), "Approval History" (the create/approve/
   * reject subset of that same audit trail), and "Usage Statistics" (a
   * real aggregate over `CurrencyConversionModel.rateId` — how many real
   * business conversions actually resolved against this exact rate row,
   * not a fabricated popularity metric). "Merchant"/"Company"/"Branch" are
   * dropped — no backing entity for any of them (see this Part's own
   * doc section in docs/05-api/07-finance-api.md).
   */
  static async getExchangeRateById(rateId, tenantId) {
    const exchangeRate = await ExchangeRateModel.findOne({ _id: rateId, tenantId }).lean();
    if (!exchangeRate) throw new Error("Exchange rate not found.");

    const [historicalVersions, auditHistory, usageStats] = await Promise.all([
      ExchangeRateModel.find({ tenantId, fromCurrency: exchangeRate.fromCurrency, toCurrency: exchangeRate.toCurrency, rateType: exchangeRate.rateType })
        .sort({ version: 1 }).select("rate version effectiveDate expiresAt approvalStatus provider source createdAt").lean(),
      AuditLogModel.find({ tenantId, resource: "ExchangeRate", resourceId: exchangeRate._id.toString() }).sort({ createdAt: -1 }).lean(),
      CurrencyConversionModel.aggregate([
        { $match: { tenantId, rateId: exchangeRate._id } },
        { $group: { _id: null, usageCount: { $sum: 1 }, totalConvertedAmount: { $sum: "$convertedAmount" }, lastUsedAt: { $max: "$createdAt" } } }
      ])
    ]);

    const approvalHistory = auditHistory.filter((a) => ["finance.currency.create_rate", "finance.currency.approve_rate", "finance.currency.reject_rate"].includes(a.action));

    return {
      ...exchangeRate,
      historicalVersions,
      auditHistory,
      approvalHistory,
      usageStatistics: {
        usageCount: usageStats[0]?.usageCount || 0,
        totalConvertedAmount: roundCurrency(usageStats[0]?.totalConvertedAmount || 0, 8),
        lastUsedAt: usageStats[0]?.lastUsedAt || null
      }
    };
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
    // "Observability... Provider Latency." (File 7 Part 5) — real,
    // measured wall-clock time of the actual HTTP call, logged either way
    // (never a fabricated metric), plus the real "Provider failures must
    // ... fail over when configured" AI rule reinterpreted honestly: only
    // one real provider integration exists in this codebase (Open
    // Exchange Rates) — there is no second one to fail OVER to — so this
    // publishes the real unavailability/recovery signal a tenant's own
    // alerting could act on, without fabricating a failover it can't do.
    const fetchStartedAt = Date.now();
    let payload;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Open Exchange Rates responded with HTTP ${response.status}.`);
      payload = await response.json();
      const latencyMs = Date.now() - fetchStartedAt;
      logger.info(`Open Exchange Rates import succeeded for tenant ${tenantId} in ${latencyMs}ms.`, { tenantId, provider: "OpenExchangeAPI", latencyMs });
      publishEvent("RateProviderRecovered", { tenantId, provider: "OpenExchangeAPI", latencyMs, performedBy: userId || "system" });
    } catch (error) {
      const latencyMs = Date.now() - fetchStartedAt;
      logger.error(`Open Exchange Rates import failed for tenant ${tenantId} after ${latencyMs}ms.`, { tenantId, provider: "OpenExchangeAPI", latencyMs, error: error.message });
      publishEvent("RateProviderUnavailable", { tenantId, provider: "OpenExchangeAPI", latencyMs, error: error.message, performedBy: userId || "system" });
      throw new Error(`Failed to fetch rates from Open Exchange Rates: ${error.message}`);
    }
    if (!payload || typeof payload.rates !== "object") throw new Error("Open Exchange Rates returned an unexpected response shape.");

    const effectiveDate = payload.timestamp ? new Date(payload.timestamp * 1000) : new Date();
    const imported = [];
    for (const currency of tenantCurrencies) {
      const rate = payload.rates[currency.currencyCode];
      if (!rate || rate <= 0) continue;

      // Same real versioning/supersede discipline as createExchangeRate —
      // an automatic import is never a second, parallel path around it.
      const previousActive = await ExchangeRateModel.findOne({
        tenantId, fromCurrency: baseCurrency, toCurrency: currency.currencyCode, rateType: "Spot",
        $or: [{ approvalStatus: "Activated" }, { approvalStatus: null }, { approvalStatus: { $exists: false } }]
      }).sort({ version: -1, effectiveDate: -1 });
      const version = previousActive ? (previousActive.version || 1) + 1 : 1;

      const exchangeRate = await ExchangeRateModel.create({
        tenantId, fromCurrency: baseCurrency, toCurrency: currency.currencyCode, rate, rateType: "Spot",
        provider: "OpenExchangeAPI", source: "Automatic", effectiveDate, version, supersedes: previousActive?._id || null, createdBy: userId || null
      });
      // Automatic imports are real, already-verified provider data — no
      // approval gate applies to them regardless of `exchangeRateApprovalRequired`
      // (that gate is for a human manually typing in a rate).
      await CurrencyService._activateExchangeRateRow(exchangeRate, "system");
      imported.push(exchangeRate.toJSON());
      // File 7 Part 4 — "Search Integration... Exchange Rates." The bulk
      // `RateImported` summary below has no single row id to index against;
      // this per-row event (the same one every manual create/approve
      // already publishes) is what actually keeps each imported rate's
      // search entry current.
      publishEvent("ExchangeRateUpdated", { tenantId, exchangeRateId: exchangeRate._id.toString(), fromCurrency: baseCurrency, toCurrency: currency.currencyCode, rate, rateType: "Spot", effectiveDate, version, approvalStatus: exchangeRate.approvalStatus, performedBy: "system" });
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
  /**
   * Resolves the single best candidate row for a directional pair — real,
   * config-driven "Priority configurable" provider tie-breaking (File 4
   * Part 2): among candidates sharing the exact latest qualifying
   * `effectiveDate`, the earlier-listed provider in `rateProviderPriority`
   * wins; a more recent `effectiveDate` always wins over provider
   * priority regardless. Also the real backward-compatible filter for
   * `approvalStatus` (a row created before this Part existed has no such
   * field — treated the same as "Activated", never as unusable) and
   * `expiresAt` (an expired row is excluded from live conversion the same
   * way a future-dated one already is).
   */
  static async _resolveBestRate(tenantId, from, to, rateType, asOfDate) {
    const config = getFinanceConfig();
    const filter = {
      tenantId, fromCurrency: from, toCurrency: to, rateType, effectiveDate: { $lte: asOfDate },
      $and: [
        { $or: [{ approvalStatus: "Activated" }, { approvalStatus: null }, { approvalStatus: { $exists: false } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: asOfDate } }] }
      ]
    };
    const candidates = await ExchangeRateModel.find(filter).sort({ effectiveDate: -1 }).limit(20).lean();
    if (candidates.length === 0) return null;

    const priorityIndex = (provider) => {
      const idx = config.rateProviderPriority.indexOf(provider);
      return idx === -1 ? config.rateProviderPriority.length : idx;
    };
    const latestTime = new Date(candidates[0].effectiveDate).getTime();
    const sameDate = candidates.filter((c) => new Date(c.effectiveDate).getTime() === latestTime);
    sameDate.sort((a, b) => priorityIndex(a.provider) - priorityIndex(b.provider));
    return sameDate[0];
  }

  /**
   * `options.rateType: "auto"` (File 4 Part 3 — "Rate Resolution
   * Priority... Priority configurable by tenant") tries each real
   * `rateType` in `rateTypePriority` order, for BOTH the direct and
   * reverse-pair lookup, until one resolves — never touches triangulation
   * priority (triangulation is already a last-resort fallback regardless
   * of rateType). Any other value (the default — `defaultExchangeRateType`)
   * looks at that one type only, the exact unchanged Part 1/2 behavior.
   */
  static async getRate(tenantId, fromCurrency, toCurrency, options = {}) {
    const config = getFinanceConfig();
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();
    const asOfDate = options.asOfDate ? new Date(options.asOfDate) : new Date();
    const requestedRateType = options.rateType || (await CurrencyService._defaultRateType());

    if (from === to) return { rate: 1, rateId: null, rateDate: asOfDate, rateType: requestedRateType, rateProvider: null, rateVersion: null, inverse: false, triangulated: false };

    const typesToTry = requestedRateType === "auto" ? config.rateTypePriority : [requestedRateType];
    for (const rateType of typesToTry) {
      const direct = await CurrencyService._resolveBestRate(tenantId, from, to, rateType, asOfDate);
      if (direct) return { rate: direct.rate, rateId: direct._id, rateDate: direct.effectiveDate, rateType, rateProvider: direct.provider, rateVersion: direct.version, inverse: false, triangulated: false };

      const reverse = await CurrencyService._resolveBestRate(tenantId, to, from, rateType, asOfDate);
      if (reverse) return { rate: invertRate(reverse.rate), rateId: reverse._id, rateDate: reverse.effectiveDate, rateType, rateProvider: reverse.provider, rateVersion: reverse.version, inverse: true, triangulated: false };
    }

    const baseCurrency = await CurrencyService.getBaseCurrency(tenantId);
    if (baseCurrency !== from && baseCurrency !== to) {
      try {
        const leg1 = await CurrencyService.getRate(tenantId, from, baseCurrency, { asOfDate, rateType: requestedRateType });
        const leg2 = await CurrencyService.getRate(tenantId, baseCurrency, to, { asOfDate, rateType: requestedRateType });
        return { rate: roundCurrency(leg1.rate * leg2.rate, 8), rateId: null, rateDate: asOfDate, rateType: requestedRateType, rateProvider: null, rateVersion: null, inverse: false, triangulated: true };
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

  /**
   * Converts `amount` from `fromCurrency` to `toCurrency`, rounded to the
   * target currency's own real decimal places. "Conversion Audit Trail"
   * (File 4 Part 3) is real but deliberately OPT-IN: only supplying
   * `options.source` (one of `conversionSources`) makes this persist a
   * real `CurrencyConversionModel` row and publish
   * `CurrencyConversionRequested` -> `ExchangeRateResolved` ->
   * `CurrencyConverted` -> `RateSnapshotStored` — this codebase's own
   * internal conversion calls (revaluation loops, FX exposure
   * recalculation, triangulation legs, etc.) never pass a `source` and
   * stay exactly as lightweight as before this Part, so this table
   * records real business transactions, never implementation-detail noise.
   *
   * Domain Events audit (File 4 Part 3's own list) — all real except two:
   * `CurrencyConversionRequested`/`ExchangeRateResolved`/`CurrencyConverted`/
   * `RateSnapshotStored` here; `FXGainCalculated`/`FXLossCalculated`/
   * `CurrencyRevalued`/`RevaluationJournalPosted`/`CurrencyRevaluationStarted`
   * in `revalueRecord`/`runPeriodEndRevaluation`. `HistoricalRateLocked` is
   * NOT a separate event — `RateSnapshotStored` already fires at the exact
   * moment a rate becomes permanently attached to an immutable conversion
   * record, which is the same real trigger point; publishing a second event
   * for it would be a fabricated duplicate. `TreasuryConversionCompleted`
   * is deliberately NOT published anywhere — no Treasury FX Deal/Swap/
   * Forward execution engine exists in this codebase to actually complete
   * one (TreasuryService only tracks positions/exposure — see its own doc
   * comments), so there is no real trigger to fire this from; faking one
   * would violate this module's own "never fabricate" discipline.
   */
  static async convert(amount, fromCurrency, toCurrency, tenantId, options = {}) {
    const { source = null, sourceReferenceId = null, correlationId = null, userId = null } = options;
    if (source) publishEvent("CurrencyConversionRequested", { tenantId, source, sourceReferenceId, originalAmount: amount, originalCurrency: fromCurrency.toUpperCase(), convertedCurrency: toCurrency.toUpperCase(), correlationId, performedBy: userId });

    const { rate, rateId, rateDate, rateType, rateProvider, rateVersion, inverse, triangulated } = await CurrencyService.getRate(tenantId, fromCurrency, toCurrency, options);
    if (source) publishEvent("ExchangeRateResolved", { tenantId, source, rateId, rateType, rateProvider, rateVersion, rate, inverse, triangulated, correlationId, performedBy: userId });

    const decimalPlaces = await CurrencyService._getDecimalPlaces(tenantId, toCurrency.toUpperCase());
    const roundingMode = options.roundingMode || getFinanceConfig().currencyRoundingMode;
    const convertedAmount = roundWithMode(amount * rate, decimalPlaces, roundingMode);
    const calculationMethod = triangulated ? "Triangulated" : (inverse ? "Inverse" : "Direct");
    const result = { convertedAmount, rate, rateId, rateDate, rateType, rateProvider, rateVersion, inverse, triangulated };

    if (source) {
      const config = getFinanceConfig();
      if (!config.conversionSources.includes(source)) throw new Error(`Invalid conversion source "${source}".`);
      const conversion = await CurrencyConversionModel.create({
        tenantId, conversionSource: source, sourceReferenceId, originalAmount: amount, originalCurrency: fromCurrency.toUpperCase(),
        convertedAmount, convertedCurrency: toCurrency.toUpperCase(), rate, rateId, rateType, rateProvider, rateVersion,
        calculationMethod, correlationId, performedBy: userId
      });
      publishEvent("CurrencyConverted", { tenantId, conversionId: conversion._id.toString(), source, sourceReferenceId, originalAmount: amount, convertedAmount, rate, calculationMethod, correlationId, performedBy: userId });
      publishEvent("RateSnapshotStored", { tenantId, conversionId: conversion._id.toString(), rateId, rateType, rateProvider, rateVersion, correlationId, performedBy: userId });
      result.conversionId = conversion._id;
    }

    return result;
  }

  /** GET /api/v1/currencies/conversions — real Conversion Audit Trail read. */
  static async listConversions(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.source) filter.conversionSource = query.source;
    if (query.originalCurrency) filter.originalCurrency = query.originalCurrency.toUpperCase();
    if (query.convertedCurrency) filter.convertedCurrency = query.convertedCurrency.toUpperCase();
    if (query.correlationId) filter.correlationId = query.correlationId;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      CurrencyConversionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      CurrencyConversionModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  // ---- Revaluation & FX Gain/Loss ----

  static async _postAutomaticJournal({ tenantId, userId, postingDate, description, currency, referenceNumber, lines }) {
    const journal = await JournalService.createJournal({ journalType: "Automatic", postingDate, description, referenceNumber, currency, lines }, tenantId, userId || "system");
    await JournalService.approveJournal(journal._id, tenantId, userId || "system");
    return JournalService.postJournal(journal._id, tenantId, userId || "system");
  }

  /**
   * Shared FX Gain/Loss journal posting — real Dr/Cr direction derived
   * once, reused by both `revalueRecord` (period-end, Unrealized) and
   * `AccountsReceivableService`/`AccountsPayableService`'s own
   * `allocatePayment` (at settlement, Realized — File 4 Part 3). For an
   * ASSET (`isLiability: false` — Bank/AR), a rising base-currency value
   * is a GAIN and the control account absorbs the debit side; for a
   * LIABILITY (AP), a rising base-currency value is a LOSS — the mirror
   * opposite, matching `calculateGainLoss`'s own sign-flip exactly. Skips
   * posting (returns null) — never fabricates a journal — until both
   * `fxGainAccountCode`/`fxLossAccountCode` AND the caller's own
   * `controlAccountCode` are configured, same "skip until configured"
   * fallback every other optional posting in this module uses.
   */
  static async postFxGainLossJournal({ tenantId, userId, postingDate, description, baseCurrency, controlAccountCode, isLiability, gainLossAmount, gainLossType, referenceNumber }) {
    const config = getFinanceConfig();
    if (!gainLossType || gainLossAmount <= 0 || !config.fxGainAccountCode || !config.fxLossAccountCode || !controlAccountCode) return null;

    const isGain = gainLossType.endsWith("Gain");
    const controlIsDebit = (isGain && !isLiability) || (!isGain && isLiability);
    const lines = controlIsDebit
      ? [{ accountCode: controlAccountCode, debit: gainLossAmount }, { accountCode: isGain ? config.fxGainAccountCode : config.fxLossAccountCode, credit: gainLossAmount }]
      : [{ accountCode: isGain ? config.fxGainAccountCode : config.fxLossAccountCode, debit: gainLossAmount }, { accountCode: controlAccountCode, credit: gainLossAmount }];

    return CurrencyService._postAutomaticJournal({ tenantId, userId, postingDate, description, currency: baseCurrency, referenceNumber, lines });
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

    const journal = await CurrencyService.postFxGainLossJournal({
      tenantId, userId, postingDate: asOfDate, description: `FX ${gainLossType} on ${targetType} ${targetId}`, baseCurrency, controlAccountCode,
      isLiability, gainLossAmount, gainLossType, referenceNumber: targetId.toString()
    });
    const journalId = journal?._id || null;
    if (journalId) publishEvent("RevaluationJournalPosted", { tenantId, targetType, targetId: targetId.toString(), journalId: journalId.toString(), gainLossAmount, gainLossType, performedBy: userId || "system" });

    const revaluation = await CurrencyRevaluationModel.create({
      tenantId, revaluationDate: asOfDate, targetType, targetId, currencyCode: currency.toUpperCase(), baseCurrencyCode: baseCurrency,
      foreignAmount, previousBaseAmount, currentBaseAmount, rateUsed: rate, rateId, gainLossAmount, gainLossType, journalId, performedBy: userId || "system"
    });

    await AuditLogModel.create({ action: "finance.currency.revalue", module: "Finance", resource: targetType, resourceId: targetId.toString(), userId: userId || null, tenantId, details: { gainLossAmount, gainLossType, rate } });
    publishEvent("CurrencyRevalued", { tenantId, revaluationId: revaluation._id.toString(), targetType, targetId: targetId.toString(), currencyCode: currency.toUpperCase(), gainLossAmount, gainLossType, performedBy: userId || "system" });
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

    publishEvent("CurrencyRevaluationStarted", { tenantId, revaluationDate, targets: config.fxRevaluationTargets, performedBy: userId || "system" });

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

    // File 4 Part 3 — 4th real revaluation target. `treasuryInvestmentControlAccountCode`
    // defaults unconfigured (null), same "skip posting, never fabricate" fallback
    // `postFxGainLossJournal` already applies to every other target's control account —
    // the revaluation record itself is still created either way.
    if (config.fxRevaluationTargets.includes("TreasuryInvestment")) {
      const investments = await TreasuryInvestmentModel.find({ tenantId, status: "Active", currency: { $ne: baseCurrency }, currentValue: { $gt: 0 } }).lean();
      for (const investment of investments) {
        const result = await CurrencyService.revalueRecord({
          targetType: "TreasuryInvestment", targetId: investment._id, currency: investment.currency, foreignAmount: investment.currentValue,
          controlAccountCode: config.treasuryInvestmentControlAccountCode, bookingDate: investment.startDate, tenantId, revaluationDate, userId
        });
        if (result) results.push(result);
      }
    }

    // File 7 Part 3 — "Cash Accounts." Real per-location control account
    // (`glAccountCode`), same as BankAccount's own block above.
    if (config.fxRevaluationTargets.includes("CashLocation")) {
      const cashLocations = await CashLocationModel.find({ tenantId, status: "Opened", currency: { $ne: baseCurrency }, balance: { $gt: 0 } }).lean();
      for (const location of cashLocations) {
        const result = await CurrencyService.revalueRecord({
          targetType: "CashLocation", targetId: location._id, currency: location.currency, foreignAmount: location.balance,
          controlAccountCode: location.glAccountCode, bookingDate: location.createdAt, tenantId, revaluationDate, userId
        });
        if (result) results.push(result);
      }
    }

    // File 7 Part 3 — "Loans." `treasuryDebtControlAccountCode` defaults
    // unconfigured, same skip-until-configured fallback as every other
    // shared control account here.
    if (config.fxRevaluationTargets.includes("TreasuryDebt")) {
      const debts = await TreasuryDebtModel.find({ tenantId, status: "Active", currency: { $ne: baseCurrency }, outstandingBalance: { $gt: 0 } }).lean();
      for (const debt of debts) {
        const result = await CurrencyService.revalueRecord({
          targetType: "TreasuryDebt", targetId: debt._id, currency: debt.currency, foreignAmount: debt.outstandingBalance,
          controlAccountCode: config.treasuryDebtControlAccountCode, bookingDate: debt.createdAt, tenantId, revaluationDate, userId
        });
        if (result) results.push(result);
      }
    }

    const totalGain = roundCurrency(results.filter((r) => r.gainLossType === "Unrealized Gain").reduce((sum, r) => sum + r.gainLossAmount, 0));
    const totalLoss = roundCurrency(results.filter((r) => r.gainLossType === "Unrealized Loss").reduce((sum, r) => sum + r.gainLossAmount, 0));

    // "RevaluationCompleted" (File 7 Part 5) — the real completion
    // counterpart to `CurrencyRevaluationStarted` published above; every
    // `CurrencyRevalued` in between is per-record, this is the one
    // real per-run summary event.
    publishEvent("RevaluationCompleted", { tenantId, revaluationDate, revalued: results.length, totalGain, totalLoss, baseCurrency, performedBy: userId || "system" });

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

  /**
   * GET /api/v1/currencies/dashboard — File 7 Part 4's own "Read Models...
   * Built asynchronously using events" section, reinterpreted honestly:
   * this codebase has no separate materialized read-model store/worker
   * (same boundary every other Part's own "async worker pipeline" ask has
   * hit) — every field here is a real, live aggregate computed on read,
   * over the exact same collections the rest of this module already
   * writes to. "Merchant Currency Usage" is dropped — no Merchant model.
   */
  static async getCurrencyDashboard(tenantId) {
    const config = getFinanceConfig();
    const [activeCurrencies, totalCurrencies, pendingCurrencyApprovals, pendingRateApprovals, latestRates, lastImportAudit, exposure, recentRevaluations] = await Promise.all([
      CurrencyModel.countDocuments({ tenantId, status: "Active" }),
      CurrencyModel.countDocuments({ tenantId }),
      CurrencyModel.countDocuments({ tenantId, status: "Pending Approval" }),
      ExchangeRateModel.countDocuments({ tenantId, approvalStatus: "Pending Approval" }),
      ExchangeRateModel.find({ tenantId, approvalStatus: "Activated" }).sort({ effectiveDate: -1 }).limit(10).select("fromCurrency toCurrency rate rateType provider effectiveDate version").lean(),
      AuditLogModel.findOne({ tenantId, action: "finance.currency.import_rates" }).sort({ createdAt: -1 }).lean(),
      CurrencyService.getCurrencyExposure(tenantId),
      CurrencyRevaluationModel.find({ tenantId }).sort({ revaluationDate: -1 }).limit(50).select("revaluationDate targetType gainLossAmount gainLossType").lean()
    ]);

    const unrealizedGain = roundCurrency(recentRevaluations.filter((r) => r.gainLossType === "Unrealized Gain").reduce((sum, r) => sum + r.gainLossAmount, 0));
    const unrealizedLoss = roundCurrency(recentRevaluations.filter((r) => r.gainLossType === "Unrealized Loss").reduce((sum, r) => sum + r.gainLossAmount, 0));

    return {
      activeCurrencies: { active: activeCurrencies, total: totalCurrencies },
      latestExchangeRates: latestRates,
      // "Rate Import Status" / "Provider Health" — real, derived from the
      // same `AuditLogModel` row `importRatesFromProvider` already writes;
      // no fabricated uptime/latency metric invented on top.
      rateImportStatus: {
        providerConfigured: !!config.openExchangeRatesAppId,
        lastImportAt: lastImportAudit?.createdAt || null,
        lastImportDetails: lastImportAudit?.details || null
      },
      providerHealth: {
        openExchangeRates: config.openExchangeRatesAppId ? "Configured" : "NotConfigured",
        lastImportStatus: lastImportAudit ? "Success" : "NeverRun"
      },
      pendingApprovals: { currencies: pendingCurrencyApprovals, exchangeRates: pendingRateApprovals, total: pendingCurrencyApprovals + pendingRateApprovals },
      fxExposure: exposure,
      fxGainLoss: { unrealizedGain, unrealizedLoss, sampledFromRevaluations: recentRevaluations.length },
      revaluationSummary: { lastRevaluationDate: recentRevaluations[0]?.revaluationDate || null, recentRunCount: recentRevaluations.length }
    };
  }
}

export default CurrencyService;
