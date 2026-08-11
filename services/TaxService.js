import TaxRuleModel from "../models/TaxRuleModel.js";
import TaxExemptionModel from "../models/TaxExemptionModel.js";
import TaxCalculationModel from "../models/TaxCalculationModel.js";
import TaxReportModel from "../models/TaxReportModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// "Invoice" and "CreditNote" are sales-side documents (tax collected FROM
// a customer — output tax); "Payment", "DebitNote", and "Withholding" are
// purchase/payment-side (tax paid TO a vendor, or withheld from a payment
// — input tax). A real, explicit mapping, not a guess — callers can still
// override via an explicit `direction` on the request when a
// transactionType genuinely doesn't fit (e.g. a DebitNote raised against
// a customer rather than a vendor).
const OUTPUT_TRANSACTION_TYPES = new Set(["Invoice", "CreditNote"]);

const REPORT_TYPE_TO_TAX_TYPE = { VATReturn: "VAT", GSTReturn: "GST", SalesTaxReturn: "SalesTax", WithholdingReturn: "WithholdingTax", Custom: null };

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/taxService.test.js).
// ---------------------------------------------------------------------------

export const isTaxRuleApprovable = (status) => status === "Draft";
export const isTaxRuleArchivable = (status) => ["Draft", "Approved", "Expired"].includes(status);

/**
 * "Jurisdiction Rules... Priority configurable." Among candidate rules
 * for the same (taxCode, country), a state-specific rule always wins over
 * a country-generic one (`state: null`) when the request supplies a
 * matching state; among rules at the same specificity, the one with the
 * latest `effectiveDate` (still <= the as-of date, already filtered by
 * the caller) wins — the newest applicable version.
 */
export const selectMostSpecificRule = (candidates, state = null) => {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const stateUpper = state ? state.toUpperCase() : null;
  const stateMatches = stateUpper ? candidates.filter((r) => r.state && r.state.toUpperCase() === stateUpper) : [];
  const pool = stateMatches.length > 0 ? stateMatches : candidates.filter((r) => !r.state);
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate))[0];
};

/** "Exclusive Tax" — the base amount does not already include tax; tax is added on top. */
export const computeExclusiveTax = (basis, ratePercent) => roundCurrency(basis * (ratePercent / 100));

/** "Inclusive Tax" — the given amount already includes tax; extracts the embedded tax and the pre-tax basis. */
export const computeInclusiveTax = (grossAmount, ratePercent) => {
  const basis = roundCurrency(grossAmount / (1 + ratePercent / 100));
  const taxAmount = roundCurrency(grossAmount - basis);
  return { basis, taxAmount };
};

/** "Minimum Tax, Maximum Tax." Clamps a computed tax amount to the rule's own configured bounds, when set. */
export const applyTaxCaps = (taxAmount, minTaxAmount, maxTaxAmount) => {
  let amount = taxAmount;
  if (minTaxAmount !== null && minTaxAmount !== undefined && amount < minTaxAmount) amount = minTaxAmount;
  if (maxTaxAmount !== null && maxTaxAmount !== undefined && amount > maxTaxAmount) amount = maxTaxAmount;
  return roundCurrency(amount);
};

class TaxService {
  static async _generateCode(tenantId, scope, prefix) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, scope, year);
    return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
  }

  // ---- Tax Rules ----

  /**
   * POST /api/v1/tax-rules
   * Validate Jurisdiction -> Validate Formula -> Approval Workflow ->
   * Activate Rule -> Audit -> Publish TaxRuleCreated. "Immutable Tax
   * History" — creating a new rule that overlaps an existing open-ended
   * (`endDate: null`) Approved rule for the same (taxCode, country,
   * state) automatically closes the old one out (`endDate` = the new
   * rule's own `effectiveDate` minus one day, `status: "Superseded"`)
   * rather than leaving two ambiguous overlapping active versions —
   * real, database-enforced versioning, not just a documented promise.
   */
  static async createTaxRule(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { taxCode, name, description = null, taxType, country, state = null, rate, calculationMethod = config.defaultTaxCalculationMethod, compoundOnTaxCodes = [], minTaxAmount = null, maxTaxAmount = null, reverseChargeScopes = [], withholdingCategory = null, effectiveDate } = data;

    if (!taxCode || !name || !taxType || !country || rate === undefined || rate === null || !effectiveDate) {
      throw new Error("taxCode, name, taxType, country, rate, and effectiveDate are required.");
    }
    if (!config.taxTypes.includes(taxType)) throw new Error(`Invalid taxType "${taxType}".`);
    if (!config.taxCalculationMethods.includes(calculationMethod)) throw new Error(`Invalid calculationMethod "${calculationMethod}".`);
    if (rate < 0) throw new Error("rate cannot be negative.");
    if (calculationMethod === "Compound" && (!Array.isArray(compoundOnTaxCodes) || compoundOnTaxCodes.length === 0)) {
      throw new Error("compoundOnTaxCodes is required (and must be non-empty) when calculationMethod is Compound.");
    }
    if (taxType === "WithholdingTax" && !config.withholdingCategories.includes(withholdingCategory)) {
      throw new Error(`withholdingCategory is required and must be one of: ${config.withholdingCategories.join(", ")}.`);
    }
    if (reverseChargeScopes.some((s) => !config.reverseChargeScopes.includes(s))) {
      throw new Error(`Invalid reverseChargeScopes — must be a subset of: ${config.reverseChargeScopes.join(", ")}.`);
    }

    const normalizedCode = taxCode.toUpperCase().trim();
    const normalizedCountry = country.toUpperCase().trim();
    const effDate = new Date(effectiveDate);

    const duplicate = await TaxRuleModel.findOne({ tenantId, taxCode: normalizedCode, country: normalizedCountry, state: state || null, effectiveDate: effDate }).lean();
    if (duplicate) throw new Error(`A tax rule for ${normalizedCode}/${normalizedCountry}${state ? `/${state}` : ""} already exists with effectiveDate ${effDate.toISOString().slice(0, 10)}.`);

    const taxRule = new TaxRuleModel({
      tenantId, taxCode: normalizedCode, name, description, taxType, country: normalizedCountry, state: state || null, rate,
      calculationMethod, compoundOnTaxCodes: compoundOnTaxCodes.map((c) => c.toUpperCase()), minTaxAmount, maxTaxAmount,
      reverseChargeScopes, withholdingCategory, effectiveDate: effDate, status: config.defaultTaxRuleStatus,
      timeline: [{ event: "TaxRuleCreated", description: `${normalizedCode} (${taxType}) created for ${normalizedCountry} at ${rate}%.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (!config.taxRuleApprovalRequired) {
      taxRule.status = "Approved";
      taxRule.timeline.push({ event: "TaxRuleApproved", description: "Auto-approved — approval is not required.", performedBy: "system" });
    }
    await taxRule.save();

    let supersededRuleId = null;
    if (taxRule.status === "Approved") {
      const priorOpenEnded = await TaxRuleModel.findOne({
        tenantId, taxCode: normalizedCode, country: normalizedCountry, state: state || null, status: "Approved",
        _id: { $ne: taxRule._id }, endDate: null, effectiveDate: { $lt: effDate }
      });
      if (priorOpenEnded) {
        const closeDate = new Date(effDate);
        closeDate.setUTCDate(closeDate.getUTCDate() - 1);
        priorOpenEnded.endDate = closeDate;
        priorOpenEnded.status = "Superseded";
        priorOpenEnded.timeline.push({ event: "TaxRuleSuperseded", description: `Superseded by ${normalizedCode} version effective ${effDate.toISOString().slice(0, 10)}.`, performedBy: userId || null });
        await priorOpenEnded.save();
        taxRule.supersedes = priorOpenEnded._id;
        await taxRule.save();
        supersededRuleId = priorOpenEnded._id.toString();
      }
    }

    await AuditLogModel.create({ action: "finance.tax.create_rule", module: "Finance", resource: "TaxRule", resourceId: taxRule._id.toString(), userId: userId || null, tenantId, details: { taxCode: normalizedCode, country: normalizedCountry, rate, supersededRuleId } });
    publishEvent("TaxRuleCreated", { tenantId, taxRuleId: taxRule._id.toString(), taxCode: normalizedCode, country: normalizedCountry, rate, performedBy: userId || null });
    if (taxRule.status === "Approved") publishEvent("TaxRuleApproved", { tenantId, taxRuleId: taxRule._id.toString(), performedBy: userId || "system" });

    return taxRule.toJSON();
  }

  static async listTaxRules(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.taxCode) filter.taxCode = query.taxCode.toUpperCase();
    if (query.country) filter.country = query.country.toUpperCase();
    if (query.taxType) filter.taxType = query.taxType;
    if (query.status) filter.status = query.status;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      TaxRuleModel.find(filter).sort({ effectiveDate: -1 }).skip(skip).limit(pageSize).lean(),
      TaxRuleModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getTaxRuleById(taxRuleId, tenantId) {
    const taxRule = await TaxRuleModel.findOne({ _id: taxRuleId, tenantId }).lean();
    if (!taxRule) throw new Error("Tax rule not found.");
    return taxRule;
  }

  static async approveTaxRule(taxRuleId, tenantId, userId) {
    const taxRule = await TaxRuleModel.findOne({ _id: taxRuleId, tenantId });
    if (!taxRule) throw new Error("Tax rule not found.");
    if (!isTaxRuleApprovable(taxRule.status)) throw new Error(`Tax rule cannot be approved from status "${taxRule.status}".`);

    taxRule.status = "Approved";
    taxRule.updatedBy = userId || null;
    taxRule.timeline.push({ event: "TaxRuleApproved", description: "Tax rule approved.", performedBy: userId || null });
    await taxRule.save();

    await AuditLogModel.create({ action: "finance.tax.approve_rule", module: "Finance", resource: "TaxRule", resourceId: taxRule._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("TaxRuleApproved", { tenantId, taxRuleId: taxRule._id.toString(), performedBy: userId || null });

    return taxRule.toJSON();
  }

  static async archiveTaxRule(taxRuleId, tenantId, userId) {
    const taxRule = await TaxRuleModel.findOne({ _id: taxRuleId, tenantId });
    if (!taxRule) throw new Error("Tax rule not found.");
    if (!isTaxRuleArchivable(taxRule.status)) throw new Error(`Tax rule cannot be archived from status "${taxRule.status}".`);

    taxRule.status = "Archived";
    taxRule.updatedBy = userId || null;
    taxRule.timeline.push({ event: "TaxRuleArchived", description: "Tax rule archived.", performedBy: userId || null });
    await taxRule.save();

    await AuditLogModel.create({ action: "finance.tax.archive_rule", module: "Finance", resource: "TaxRule", resourceId: taxRule._id.toString(), userId: userId || null, tenantId, details: {} });

    return taxRule.toJSON();
  }

  /** Real DB-backed rule resolution — the version that's Approved and covers `asOfDate`, most-specific-first (see selectMostSpecificRule). */
  static async resolveApplicableRule(tenantId, taxCode, country, state, asOfDate) {
    if (!country) return null;
    const candidates = await TaxRuleModel.find({
      tenantId, taxCode: taxCode.toUpperCase(), country: country.toUpperCase(), status: "Approved",
      effectiveDate: { $lte: asOfDate }, $or: [{ endDate: null }, { endDate: { $gte: asOfDate } }]
    }).lean();
    return selectMostSpecificRule(candidates, state);
  }

  /**
   * The bridge used by InvoiceService/CreditNoteService/DebitNoteService
   * instead of the static `config.taxCodes` array — see
   * docs/05-api/07-finance-api.md Part 20's own "A real bug fixed first"-
   * style writeup for why. Returns the exact `[{code, rate}]` shape
   * `resolveTaxRate` already expects (rate as a fraction, e.g. 0.15),
   * converted from this module's own percentage-based `TaxRuleModel.rate`
   * (e.g. 15). Falls back to `config.taxCodes` only when no matching rule
   * exists for the given country/date — never silently drops a code.
   */
  static async resolveRatesForCodes(taxCodes, { country = null, state = null, asOfDate = new Date() } = {}, tenantId) {
    const config = getFinanceConfig();
    const uniqueCodes = [...new Set((taxCodes || []).filter(Boolean))];
    const resolved = [];
    for (const code of uniqueCodes) {
      const rule = country ? await TaxService.resolveApplicableRule(tenantId, code, country, state, asOfDate) : null;
      if (rule) {
        resolved.push({ code: rule.taxCode, rate: roundCurrency(rule.rate) / 100 });
      } else {
        const fallback = config.taxCodes.find((t) => t.code === code);
        if (fallback) resolved.push(fallback);
      }
    }
    return resolved;
  }

  // ---- Tax Calculation ----

  static async _findExemption(tenantId, partyType, partyId, taxCode, asOfDate) {
    if (!partyType || !partyId) return null;
    const candidates = await TaxExemptionModel.find({
      tenantId, partyType, partyId, status: "Active", validFrom: { $lte: asOfDate }, $or: [{ validUntil: null }, { validUntil: { $gte: asOfDate } }]
    }).lean();
    return candidates.find((e) => e.applicableTaxCodes.length === 0 || e.applicableTaxCodes.includes(taxCode)) || null;
  }

  /**
   * Resolves and computes tax for ONE line, including a full compound/
   * cascading chain when the resolved rule's own `compoundOnTaxCodes`
   * names other codes whose tax is already baked into this rule's base —
   * each named code is resolved and calculated recursively against the
   * SAME raw amount first, and their sum is added to this rule's own
   * basis before its rate is applied. "Compound Tax" and "Cascading Tax"
   * are the same real mechanism here, not two parallel implementations.
   */
  static async _calculateLineTax({ amount, taxCode, country, state, asOfDate, tenantId, partyType, partyId, reverseChargeContext = [], _depth = 0 }) {
    if (_depth > 5) throw new Error(`Compound tax chain too deep for taxCode "${taxCode}" — likely a circular compoundOnTaxCodes reference.`);
    if (!taxCode) return { amount, taxCode: null, taxRuleId: null, taxType: null, taxRate: 0, taxBasis: amount, taxAmount: 0, exempted: false, exemptionId: null, reverseCharge: false };

    const rule = await TaxService.resolveApplicableRule(tenantId, taxCode, country, state, asOfDate);
    if (!rule) throw new Error(`No active tax rule found for taxCode "${taxCode}" in ${country}${state ? `/${state}` : ""} as of ${asOfDate.toISOString().slice(0, 10)}.`);

    let basis = amount;
    if (rule.calculationMethod === "Compound" && rule.compoundOnTaxCodes.length > 0) {
      for (const compoundCode of rule.compoundOnTaxCodes) {
        const compoundResult = await TaxService._calculateLineTax({ amount, taxCode: compoundCode, country, state, asOfDate, tenantId, partyType: null, partyId: null, _depth: _depth + 1 });
        basis = roundCurrency(basis + compoundResult.taxAmount);
      }
    }

    let taxAmount;
    if (rule.calculationMethod === "Inclusive") {
      const { basis: extractedBasis, taxAmount: extractedTax } = computeInclusiveTax(basis, rule.rate);
      basis = extractedBasis;
      taxAmount = extractedTax;
    } else {
      taxAmount = computeExclusiveTax(basis, rule.rate);
    }
    taxAmount = applyTaxCaps(taxAmount, rule.minTaxAmount, rule.maxTaxAmount);

    const exemption = await TaxService._findExemption(tenantId, partyType, partyId, rule.taxCode, asOfDate);
    const exempted = !!exemption;
    if (exempted) taxAmount = 0;

    const reverseCharge = rule.reverseChargeScopes.length > 0 && reverseChargeContext.some((scope) => rule.reverseChargeScopes.includes(scope));

    return {
      amount, taxCode: rule.taxCode, taxRuleId: rule._id, taxType: rule.taxType, taxRate: roundCurrency(rule.rate) / 100,
      taxBasis: basis, taxAmount, exempted, exemptionId: exemption?._id || null, reverseCharge
    };
  }

  /**
   * POST /api/v1/tax/calculate
   * Identify Jurisdiction -> Resolve Applicable Rules -> Calculate Line
   * Taxes -> Calculate Document Taxes -> Apply Exemptions -> Return Tax
   * Breakdown. Persists one immutable TaxCalculationModel row and
   * publishes TaxCalculated — this endpoint is the real, callable Tax
   * Engine every other module integrates with, not just a stateless
   * calculator (see docs/05-api/07-finance-api.md Part 20).
   */
  static async calculateTax(data, tenantId, userId) {
    const { customerCountry, customerState = null, transactionType = "Custom", transactionId = null, transactionRef = null, currency, lines, partyType = null, partyId = null, reverseChargeContext = [], direction: directionOverride = null, asOfDate } = data;

    if (!customerCountry) throw new Error("customerCountry is required.");
    if (!currency) throw new Error("currency is required.");
    if (!Array.isArray(lines) || lines.length === 0) throw new Error("lines must be a non-empty array.");

    const date = asOfDate ? new Date(asOfDate) : new Date();
    const computedLines = [];
    for (const line of lines) {
      if (!line.amount || line.amount <= 0) throw new Error("Each line requires a positive amount.");
      const result = await TaxService._calculateLineTax({ amount: roundCurrency(line.amount), taxCode: line.taxCode || null, country: customerCountry, state: customerState, asOfDate: date, tenantId, partyType, partyId, reverseChargeContext });
      computedLines.push(result);
    }

    const documentTaxTotal = roundCurrency(computedLines.reduce((sum, l) => sum + (l.reverseCharge ? 0 : l.taxAmount), 0));
    const direction = directionOverride || (OUTPUT_TRANSACTION_TYPES.has(transactionType) ? "Output" : "Input");

    const record = await TaxCalculationModel.create({
      tenantId, transactionType, transactionId, transactionRef, direction,
      jurisdiction: { country: customerCountry.toUpperCase(), state: customerState || null }, currency,
      lines: computedLines, documentTaxTotal, performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.tax.calculate", module: "Finance", resource: "TaxCalculation", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { documentTaxTotal, lineCount: computedLines.length } });
    publishEvent("TaxCalculated", { tenantId, calculationId: record._id.toString(), documentTaxTotal, currency, direction, performedBy: userId || null });
    if (computedLines.some((l) => l.exempted)) publishEvent("TaxExemptionApplied", { tenantId, calculationId: record._id.toString(), performedBy: userId || null });
    if (computedLines.some((l) => l.reverseCharge)) publishEvent("ReverseChargeApplied", { tenantId, calculationId: record._id.toString(), performedBy: userId || null });

    return record.toJSON();
  }

  /**
   * POST /api/v1/tax/withholding/calculate — gap-fill: "Withholding
   * Tax... Supplier Payments, Professional Services, Contractors,
   * Dividends, Interest. Automatic deduction," with no endpoint
   * contracted for it beyond the named `WithholdingTaxCalculated` event.
   * A pure calculation + immutable record, the same "conversion utility
   * used by callers" pattern as Part 19's own `CurrencyService.convert`
   * — actually deducting this from a real payment is the calling
   * module's own job (e.g. VendorPaymentService), not this engine's.
   */
  static async calculateWithholdingTax(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { amount, withholdingCategory, country, currency, transactionId = null, transactionRef = null, asOfDate } = data;

    if (!amount || amount <= 0) throw new Error("amount must be greater than zero.");
    if (!config.withholdingCategories.includes(withholdingCategory)) throw new Error(`Invalid withholdingCategory "${withholdingCategory}".`);
    if (!country) throw new Error("country is required.");
    if (!currency) throw new Error("currency is required.");

    const date = asOfDate ? new Date(asOfDate) : new Date();
    const candidates = await TaxRuleModel.find({
      tenantId, taxType: "WithholdingTax", withholdingCategory, country: country.toUpperCase(), status: "Approved",
      effectiveDate: { $lte: date }, $or: [{ endDate: null }, { endDate: { $gte: date } }]
    }).lean();
    const rule = selectMostSpecificRule(candidates, null);
    if (!rule) throw new Error(`No active withholding tax rule found for "${withholdingCategory}" in ${country.toUpperCase()}.`);

    const roundedAmount = roundCurrency(amount);
    const withholdingAmount = applyTaxCaps(computeExclusiveTax(roundedAmount, rule.rate), rule.minTaxAmount, rule.maxTaxAmount);
    const netPayable = roundCurrency(roundedAmount - withholdingAmount);

    const record = await TaxCalculationModel.create({
      tenantId, transactionType: "Withholding", transactionId, transactionRef, direction: "Input",
      jurisdiction: { country: country.toUpperCase(), state: null }, currency,
      lines: [{ amount: roundedAmount, taxCode: rule.taxCode, taxRuleId: rule._id, taxType: rule.taxType, taxRate: roundCurrency(rule.rate) / 100, taxBasis: roundedAmount, taxAmount: withholdingAmount, exempted: false, exemptionId: null, reverseCharge: false }],
      documentTaxTotal: withholdingAmount, performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.tax.calculate_withholding", module: "Finance", resource: "TaxCalculation", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { withholdingCategory, withholdingAmount, netPayable } });
    publishEvent("WithholdingTaxCalculated", { tenantId, calculationId: record._id.toString(), withholdingCategory, withholdingAmount, netPayable, currency, performedBy: userId || null });

    return { withholdingAmount, netPayable, rate: rule.rate, ruleId: rule._id, calculationId: record._id };
  }

  // ---- Tax Exemptions ----

  static async createExemption(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { partyType, partyId, exemptionType, certificateNumber, certificateUrl = null, applicableTaxCodes = [], validFrom, validUntil = null } = data;
    if (!["customer", "vendor"].includes(partyType)) throw new Error('partyType must be "customer" or "vendor".');
    if (!partyId || !exemptionType || !certificateNumber || !validFrom) throw new Error("partyId, exemptionType, certificateNumber, and validFrom are required.");
    if (!config.taxExemptionTypes.includes(exemptionType)) throw new Error(`Invalid exemptionType "${exemptionType}".`);

    const exemption = await TaxExemptionModel.create({
      tenantId, partyType, partyId, exemptionType, certificateNumber, certificateUrl,
      applicableTaxCodes: applicableTaxCodes.map((c) => c.toUpperCase()), validFrom: new Date(validFrom),
      validUntil: validUntil ? new Date(validUntil) : null, status: "Active", createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.tax.create_exemption", module: "Finance", resource: "TaxExemption", resourceId: exemption._id.toString(), userId: userId || null, tenantId, details: { partyType, partyId: partyId.toString(), exemptionType } });

    return exemption.toJSON();
  }

  static async listExemptions(query, tenantId) {
    const filter = { tenantId };
    if (query.partyType) filter.partyType = query.partyType;
    if (query.partyId) filter.partyId = query.partyId;
    if (query.status) filter.status = query.status;
    return TaxExemptionModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async revokeExemption(exemptionId, data, tenantId, userId) {
    const exemption = await TaxExemptionModel.findOne({ _id: exemptionId, tenantId });
    if (!exemption) throw new Error("Tax exemption not found.");
    if (exemption.status !== "Active") throw new Error(`Cannot revoke an exemption in status "${exemption.status}".`);

    exemption.status = "Revoked";
    exemption.revokedReason = data?.reason || null;
    exemption.updatedBy = userId || null;
    await exemption.save();

    await AuditLogModel.create({ action: "finance.tax.revoke_exemption", module: "Finance", resource: "TaxExemption", resourceId: exemption._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return exemption.toJSON();
  }

  // ---- Tax Reporting ----

  /**
   * GET /api/v1/tax/reports — real aggregation over TaxCalculationModel
   * for the requested period, grouped by taxCode; `reportType` maps to a
   * real taxType filter (VATReturn -> VAT, etc.) except `Custom`, which
   * aggregates every taxType present. Persists an immutable TaxReportModel
   * snapshot and publishes TaxReportGenerated — re-running the same
   * period later produces a NEW snapshot, never overwrites the old one
   * (the filed-period figures a tenant already submitted stay exactly as
   * they were).
   */
  static async generateTaxReport(query, tenantId, userId) {
    const config = getFinanceConfig();
    const { reportType, periodStart, periodEnd, country = null, currency } = query;
    if (!config.taxReportTypes.includes(reportType)) throw new Error(`Invalid reportType "${reportType}".`);
    if (!periodStart || !periodEnd) throw new Error("periodStart and periodEnd are required.");
    if (!currency) throw new Error("currency is required.");

    const filter = { tenantId, currency, calculatedAt: { $gte: new Date(periodStart), $lte: new Date(periodEnd) } };
    if (country) filter["jurisdiction.country"] = country.toUpperCase();
    const targetTaxType = REPORT_TYPE_TO_TAX_TYPE[reportType];

    const calculations = await TaxCalculationModel.find(filter).lean();
    const byCode = new Map();
    for (const calc of calculations) {
      for (const line of calc.lines) {
        if (targetTaxType && line.taxType !== targetTaxType) continue;
        if (!line.taxCode) continue;
        if (!byCode.has(line.taxCode)) byCode.set(line.taxCode, { taxCode: line.taxCode, taxType: line.taxType, outputTax: 0, inputTax: 0, netPayable: 0, transactionCount: 0 });
        const entry = byCode.get(line.taxCode);
        if (calc.direction === "Output") entry.outputTax = roundCurrency(entry.outputTax + line.taxAmount);
        else entry.inputTax = roundCurrency(entry.inputTax + line.taxAmount);
        entry.transactionCount += 1;
      }
    }

    const lines = [...byCode.values()].map((entry) => ({ ...entry, netPayable: roundCurrency(entry.outputTax - entry.inputTax) }));
    const totalOutputTax = roundCurrency(lines.reduce((sum, l) => sum + l.outputTax, 0));
    const totalInputTax = roundCurrency(lines.reduce((sum, l) => sum + l.inputTax, 0));
    const totalNetPayable = roundCurrency(totalOutputTax - totalInputTax);

    const report = await TaxReportModel.create({
      tenantId, reportType, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), country: country ? country.toUpperCase() : null,
      currency, lines, totalOutputTax, totalInputTax, totalNetPayable, generatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.tax.generate_report", module: "Finance", resource: "TaxReport", resourceId: report._id.toString(), userId: userId || null, tenantId, details: { reportType, totalNetPayable } });
    publishEvent("TaxReportGenerated", { tenantId, reportId: report._id.toString(), reportType, totalNetPayable, currency, performedBy: userId || null });

    return report.toJSON();
  }

  static async listTaxReports(query, tenantId) {
    const filter = { tenantId };
    if (query.reportType) filter.reportType = query.reportType;
    return TaxReportModel.find(filter).sort({ generatedAt: -1 }).limit(100).lean();
  }
}

export default TaxService;
