import PriceListModel from "../models/PriceListModel.js";
import PriceListEntryModel from "../models/PriceListEntryModel.js";
import PricingRuleModel from "../models/PricingRuleModel.js";
import CouponModel from "../models/CouponModel.js";
import PriceCalculationModel from "../models/PriceCalculationModel.js";
import CustomerModel from "../models/CustomerModel.js";
import TaxService from "./TaxService.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/pricingService.test.js).
// ---------------------------------------------------------------------------

export const isPricingRuleApprovable = (status) => status === "Draft";
export const isPricingRuleArchivable = (status) => ["Draft", "Approved", "Expired"].includes(status);

/**
 * "Rule Priority: Product Rule -> Customer Rule -> Contract Rule ->
 * Promotion Rule -> Coupon Rule -> Loyalty Rule." Among candidates of the
 * SAME ruleType, a rule targeting an exact customerId is more specific
 * than one targeting a customerGroup, which is more specific than one
 * targeting only a productCode, which beats a wildcard rule with none of
 * the three set.
 */
export const rankRuleSpecificity = (rule) => (rule.customerId ? 4 : 0) + (rule.customerGroup ? 2 : 0) + (rule.productCode ? 1 : 0);

/** Highest specificity wins; ties broken by higher `priority`, then latest `effectiveDate`. */
export const selectBestRule = (candidates) => {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const specDiff = rankRuleSpecificity(b) - rankRuleSpecificity(a);
    if (specDiff !== 0) return specDiff;
    const priorityDiff = (b.priority || 0) - (a.priority || 0);
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.effectiveDate) - new Date(a.effectiveDate);
  })[0];
};

/** "Volume Pricing... Tier Pricing, Quantity Breaks." The best (highest-minQuantity) tier the requested quantity qualifies for. */
export const selectBestVolumeTier = (tiers, quantity) => {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const qualifying = tiers.filter((t) => quantity >= t.minQuantity).sort((a, b) => b.minQuantity - a.minQuantity);
  return qualifying[0] || null;
};

/** "Buy X Get Y" — every full (buyQuantity + getQuantity) group in `quantity` earns `getQuantity` free units, at the given unitPrice. */
export const computeBuyXGetYDiscount = (unitPrice, quantity, buyQuantity, getQuantity) => {
  if (!buyQuantity || !getQuantity || buyQuantity <= 0 || getQuantity <= 0) return 0;
  const groupSize = buyQuantity + getQuantity;
  const fullGroups = Math.floor(quantity / groupSize);
  const freeUnits = fullGroups * getQuantity;
  return roundCurrency(freeUnits * unitPrice);
};

/**
 * Real calculation exists only for Percentage/FixedAmount/BuyXGetY — see
 * utils/financeConfig.js's own `discountTypes` doc comment for why
 * FreeShipping/BundleDiscount/CategoryDiscount/CustomFormula don't
 * compute (no Shipping/Catalog/formula-engine module exists in this
 * codebase). Those four still validate as real rule configuration and
 * return 0 rather than throwing, so a rule using one doesn't break the
 * whole pipeline — just contributes no discount yet.
 */
export const applyDiscount = (baseAmount, discountType, discountValue, context = {}) => {
  if (discountType === "Percentage") return roundCurrency(baseAmount * (discountValue / 100));
  if (discountType === "FixedAmount") return roundCurrency(Math.min(discountValue, baseAmount));
  if (discountType === "BuyXGetY") return computeBuyXGetYDiscount(context.unitPrice || 0, context.quantity || 0, context.buyQuantity, context.getQuantity);
  return 0;
};

/** Real coupon validity check — status, date range, overall/per-customer usage limits, and product/customer scoping. */
export const isCouponValid = (coupon, { customerId = null, productCodes = [], asOfDate = new Date() } = {}) => {
  if (!coupon || coupon.status !== "Active") return { valid: false, reason: `Coupon is not Active (status: "${coupon?.status}").` };
  if (new Date(coupon.validFrom) > asOfDate) return { valid: false, reason: "Coupon is not yet valid." };
  if (coupon.validUntil && new Date(coupon.validUntil) < asOfDate) return { valid: false, reason: "Coupon has expired." };

  const maxUses = coupon.usageType === "SingleUse" ? 1 : coupon.usageLimit;
  if (maxUses !== null && maxUses !== undefined && coupon.usedCount >= maxUses) return { valid: false, reason: "Coupon usage limit reached." };

  if (coupon.perCustomerLimit && customerId) {
    const customerUses = (coupon.redemptions || []).filter((r) => r.customerId && r.customerId.toString() === customerId.toString()).length;
    if (customerUses >= coupon.perCustomerLimit) return { valid: false, reason: "Coupon usage limit reached for this customer." };
  }

  if (coupon.applicableCustomerIds?.length > 0 && (!customerId || !coupon.applicableCustomerIds.some((id) => id.toString() === customerId.toString()))) {
    return { valid: false, reason: "Coupon is not valid for this customer." };
  }

  if (coupon.applicableProductCodes?.length > 0 && !productCodes.some((code) => coupon.applicableProductCodes.includes(code))) {
    return { valid: false, reason: "Coupon does not apply to any product in this order." };
  }

  return { valid: true, reason: null };
};

/** "Remainder on the last line" split — same discipline used everywhere else money gets divided proportionally in this codebase (Part 18's installment schedules). */
export const allocateProportionally = (totalAmount, weights) => {
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0) return weights.map(() => 0);
  const allocations = weights.map((w) => roundCurrency((totalAmount * w) / weightSum));
  const allocatedSum = roundCurrency(allocations.reduce((sum, a) => sum + a, 0));
  const remainder = roundCurrency(totalAmount - allocatedSum);
  if (allocations.length > 0) allocations[allocations.length - 1] = roundCurrency(allocations[allocations.length - 1] + remainder);
  return allocations;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class PricingService {
  // ---- Pricing Rules ----

  /**
   * POST /api/v1/pricing-rules
   * Validate Rule -> Validate Dates -> Approval Workflow -> Activate Rule
   * -> Audit -> Publish PricingRuleCreated. "Immutable Rule History" —
   * mirrors Part 20's own TaxRuleModel auto-supersede exactly, keyed by
   * `ruleName` instead of (taxCode, country): creating a new Approved
   * version of a name that already has an open-ended (`endDate: null`)
   * Approved version automatically closes the old one out
   * (`endDate` = new rule's own `effectiveDate` minus one day,
   * `status: "Superseded"`) — real versioning, reconciling the spec's own
   * "Unique Rule Name" validation rule with "Rule Versioning... Immutable
   * history" (uniqueness holds among currently-open versions of a name,
   * not across all time).
   */
  static async createPricingRule(data, tenantId, userId) {
    const config = getFinanceConfig();
    const {
      ruleName, description = null, ruleType, promotionType = null, customerId = null, customerGroup = null, productCode = null,
      discountType = null, discountValue = 0, buyQuantity = null, getQuantity = null, fixedPrice = null, tiers = [],
      isStackable = true, priority, effectiveDate
    } = data;

    if (!ruleName || !ruleType || priority === undefined || priority === null || !effectiveDate) {
      throw new Error("ruleName, ruleType, priority, and effectiveDate are required.");
    }
    if (!config.pricingRuleTypes.includes(ruleType)) throw new Error(`Invalid ruleType "${ruleType}".`);
    if (ruleType === "Promotion" && !config.promotionTypes.includes(promotionType)) throw new Error(`promotionType is required and must be one of: ${config.promotionTypes.join(", ")}.`);
    if (ruleType === "Contract" && (fixedPrice === null || fixedPrice === undefined) && !discountType) {
      throw new Error("A Contract rule requires either fixedPrice or a discountType/discountValue.");
    }
    if (ruleType === "Volume" && (!Array.isArray(tiers) || tiers.length === 0)) throw new Error("A Volume rule requires at least one tier.");
    if (discountType && !config.discountTypes.includes(discountType)) throw new Error(`Invalid discountType "${discountType}".`);
    if (discountType === "BuyXGetY" && (!buyQuantity || !getQuantity)) throw new Error("buyQuantity and getQuantity are required when discountType is BuyXGetY.");

    const effDate = new Date(effectiveDate);
    const duplicate = await PricingRuleModel.findOne({ tenantId, ruleName, effectiveDate: effDate }).lean();
    if (duplicate) throw new Error(`A pricing rule named "${ruleName}" already exists with effectiveDate ${effDate.toISOString().slice(0, 10)}.`);

    const rule = new PricingRuleModel({
      tenantId, ruleName, description, ruleType, promotionType, customerId, customerGroup, productCode: productCode ? productCode.toUpperCase() : null,
      discountType, discountValue, buyQuantity, getQuantity, fixedPrice, tiers, isStackable, priority, effectiveDate: effDate,
      status: config.defaultPricingRuleStatus,
      timeline: [{ event: "PricingRuleCreated", description: `${ruleType} rule "${ruleName}" created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    if (!config.pricingRuleApprovalRequired) {
      rule.status = "Approved";
      rule.timeline.push({ event: "PricingRuleApproved", description: "Auto-approved — approval is not required.", performedBy: "system" });
    }
    await rule.save();

    let supersededRuleId = null;
    if (rule.status === "Approved") {
      const priorOpenEnded = await PricingRuleModel.findOne({ tenantId, ruleName, status: "Approved", _id: { $ne: rule._id }, endDate: null, effectiveDate: { $lt: effDate } });
      if (priorOpenEnded) {
        const closeDate = new Date(effDate);
        closeDate.setUTCDate(closeDate.getUTCDate() - 1);
        priorOpenEnded.endDate = closeDate;
        priorOpenEnded.status = "Superseded";
        priorOpenEnded.timeline.push({ event: "PricingRuleSuperseded", description: `Superseded by the version effective ${effDate.toISOString().slice(0, 10)}.`, performedBy: userId || null });
        await priorOpenEnded.save();
        rule.supersedes = priorOpenEnded._id;
        await rule.save();
        supersededRuleId = priorOpenEnded._id.toString();
      }
    }

    await AuditLogModel.create({ action: "finance.pricing.create_rule", module: "Finance", resource: "PricingRule", resourceId: rule._id.toString(), userId: userId || null, tenantId, details: { ruleName, ruleType, supersededRuleId } });
    publishEvent("PricingRuleCreated", { tenantId, ruleId: rule._id.toString(), ruleName, ruleType, performedBy: userId || null });
    if (rule.status === "Approved") {
      publishEvent("PricingRuleApproved", { tenantId, ruleId: rule._id.toString(), performedBy: userId || "system" });
      if (ruleType === "Promotion") publishEvent("PromotionActivated", { tenantId, ruleId: rule._id.toString(), ruleName, promotionType, performedBy: userId || "system" });
    }

    return rule.toJSON();
  }

  static async listPricingRules(query, tenantId) {
    const config = getFinanceConfig();
    const filter = { tenantId };
    if (query.ruleType) filter.ruleType = query.ruleType;
    if (query.status) filter.status = query.status;
    if (query.customerId) filter.customerId = query.customerId;

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      PricingRuleModel.find(filter).sort({ effectiveDate: -1 }).skip(skip).limit(pageSize).lean(),
      PricingRuleModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getPricingRuleById(ruleId, tenantId) {
    const rule = await PricingRuleModel.findOne({ _id: ruleId, tenantId }).lean();
    if (!rule) throw new Error("Pricing rule not found.");
    return rule;
  }

  static async approvePricingRule(ruleId, tenantId, userId) {
    const rule = await PricingRuleModel.findOne({ _id: ruleId, tenantId });
    if (!rule) throw new Error("Pricing rule not found.");
    if (!isPricingRuleApprovable(rule.status)) throw new Error(`Pricing rule cannot be approved from status "${rule.status}".`);

    rule.status = "Approved";
    rule.updatedBy = userId || null;
    rule.timeline.push({ event: "PricingRuleApproved", description: "Pricing rule approved.", performedBy: userId || null });
    await rule.save();

    await AuditLogModel.create({ action: "finance.pricing.approve_rule", module: "Finance", resource: "PricingRule", resourceId: rule._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("PricingRuleApproved", { tenantId, ruleId: rule._id.toString(), performedBy: userId || null });
    if (rule.ruleType === "Promotion") publishEvent("PromotionActivated", { tenantId, ruleId: rule._id.toString(), ruleName: rule.ruleName, promotionType: rule.promotionType, performedBy: userId || null });

    return rule.toJSON();
  }

  static async archivePricingRule(ruleId, tenantId, userId) {
    const rule = await PricingRuleModel.findOne({ _id: ruleId, tenantId });
    if (!rule) throw new Error("Pricing rule not found.");
    if (!isPricingRuleArchivable(rule.status)) throw new Error(`Pricing rule cannot be archived from status "${rule.status}".`);

    rule.status = "Archived";
    rule.updatedBy = userId || null;
    rule.timeline.push({ event: "PricingRuleArchived", description: "Pricing rule archived.", performedBy: userId || null });
    await rule.save();

    await AuditLogModel.create({ action: "finance.pricing.archive_rule", module: "Finance", resource: "PricingRule", resourceId: rule._id.toString(), userId: userId || null, tenantId, details: {} });

    return rule.toJSON();
  }

  static async _resolveApplicableRules(tenantId, { ruleType, customerId = null, customerGroup = null, productCode = null, asOfDate }) {
    const filter = {
      tenantId, ruleType, status: "Approved", effectiveDate: { $lte: asOfDate }, $or: [{ endDate: null }, { endDate: { $gte: asOfDate } }],
      $and: [
        { $or: [{ customerId: null }, { customerId }] },
        { $or: [{ customerGroup: null }, { customerGroup }] },
        { $or: [{ productCode: null }, { productCode }] }
      ]
    };
    return PricingRuleModel.find(filter).lean();
  }

  // ---- Base Price Resolution ----

  /**
   * "Product Price -> Customer Price List -> Contract Price." A Contract-
   * type rule with a `fixedPrice` wins outright (most specific, highest
   * priority in the pipeline); otherwise the best-matching PriceListModel
   * (customer-specific > customerGroup > tenant default for the
   * currency) supplies the base via its own `PriceListEntryModel`; a
   * caller-supplied `unitPrice` is the final, honest fallback — no
   * Product catalog exists in this codebase to derive one otherwise (see
   * utils/financeConfig.js's own doc comment).
   */
  static async resolveBasePrice({ productCode, customerId, customerGroup, currency, tenantId, asOfDate, fallbackUnitPrice = null }) {
    const contractCandidates = (await PricingService._resolveApplicableRules(tenantId, { ruleType: "Contract", customerId, customerGroup: null, productCode, asOfDate }))
      .filter((r) => r.fixedPrice !== null && r.fixedPrice !== undefined);
    const contractRule = selectBestRule(contractCandidates);
    if (contractRule) return { unitPrice: contractRule.fixedPrice, source: "Contract", ruleId: contractRule._id, priceListId: null };

    const priceListFilter = { tenantId, currency, status: "Active" };
    let priceList = customerId ? await PriceListModel.findOne({ ...priceListFilter, customerId }).lean() : null;
    if (!priceList && customerGroup) priceList = await PriceListModel.findOne({ ...priceListFilter, customerGroup }).lean();
    if (!priceList) priceList = await PriceListModel.findOne({ ...priceListFilter, isDefault: true }).lean();

    if (priceList) {
      const entry = await PriceListEntryModel.findOne({ tenantId, priceListId: priceList._id, productCode }).lean();
      if (entry) return { unitPrice: entry.unitPrice, source: "PriceList", ruleId: null, priceListId: priceList._id };
    }

    if (fallbackUnitPrice !== null && fallbackUnitPrice !== undefined) {
      return { unitPrice: roundCurrency(fallbackUnitPrice), source: "Caller", ruleId: null, priceListId: null };
    }

    throw new Error(`No price found for product "${productCode}" — no contract price, no price list entry, and no unitPrice was supplied.`);
  }

  /**
   * Lightweight, non-persisting resolution primitive — combines
   * `resolveBasePrice` + the Volume/Promotion discount pipeline WITHOUT
   * writing a `PriceCalculationModel` row or publishing events. This is
   * the real "every module should ask a centralized Pricing & Discount
   * Engine" entry point for OTHER services (e.g. `InvoiceService`) to
   * call internally, distinct from the full user-facing
   * `POST /pricing/calculate` orchestration (`calculatePrice` above),
   * which also handles coupons/loyalty/tax and is meant to represent one
   * real, standalone, auditable pricing decision — not an internal
   * implementation detail of another module's own document creation.
   */
  static async resolveLinePrice({ productCode, customerId = null, customerGroup = null, quantity, currency, tenantId, asOfDate = new Date(), fallbackUnitPrice = null }) {
    const basePriceResult = await PricingService.resolveBasePrice({ productCode, customerId, customerGroup, currency, tenantId, asOfDate, fallbackUnitPrice });
    const discountResult = await PricingService._calculateLineDiscounts({ productCode, customerId, customerGroup, quantity, basePrice: basePriceResult.unitPrice, tenantId, asOfDate });
    return { unitPrice: basePriceResult.unitPrice, totalDiscount: discountResult.discountAmount, appliedRules: discountResult.appliedRules, source: basePriceResult.source };
  }

  // ---- Discount pipeline (per line: Volume, then Promotion) ----

  static async _calculateLineDiscounts({ productCode, customerId, customerGroup, quantity, basePrice, tenantId, asOfDate }) {
    const lineSubtotal = roundCurrency(basePrice * quantity);
    const appliedRules = [];
    let runningAmount = lineSubtotal;
    let exclusiveWinnerApplied = false;

    const volumeCandidates = await PricingService._resolveApplicableRules(tenantId, { ruleType: "Volume", customerId, customerGroup, productCode, asOfDate });
    const volumeRule = selectBestRule(volumeCandidates);
    if (volumeRule) {
      const tier = selectBestVolumeTier(volumeRule.tiers, quantity);
      if (tier) {
        const amount = applyDiscount(runningAmount, tier.discountType, tier.discountValue, { unitPrice: basePrice, quantity, buyQuantity: volumeRule.buyQuantity, getQuantity: volumeRule.getQuantity });
        if (amount > 0) {
          runningAmount = roundCurrency(runningAmount - amount);
          appliedRules.push({ ruleId: volumeRule._id, ruleType: "Volume", description: `${volumeRule.ruleName} (qty >= ${tier.minQuantity})`, discountAmount: amount });
          if (!volumeRule.isStackable) exclusiveWinnerApplied = true;
        }
      }
    }

    if (!exclusiveWinnerApplied) {
      const promotionCandidates = await PricingService._resolveApplicableRules(tenantId, { ruleType: "Promotion", customerId, customerGroup, productCode, asOfDate });
      const promotionRule = selectBestRule(promotionCandidates);
      if (promotionRule && promotionRule.discountType) {
        const amount = applyDiscount(runningAmount, promotionRule.discountType, promotionRule.discountValue, { unitPrice: basePrice, quantity, buyQuantity: promotionRule.buyQuantity, getQuantity: promotionRule.getQuantity });
        if (amount > 0) {
          runningAmount = roundCurrency(runningAmount - amount);
          appliedRules.push({ ruleId: promotionRule._id, ruleType: "Promotion", description: promotionRule.ruleName, discountAmount: amount });
        }
      }
    }

    const discountAmount = roundCurrency(lineSubtotal - runningAmount);
    return { lineSubtotal, discountAmount, appliedRules, lineTotalAfterRules: runningAmount };
  }

  // ---- Coupons ----

  static async createCoupon(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { code, name, discountType, discountValue, usageType, usageLimit = null, perCustomerLimit = null, applicableProductCodes = [], applicableCustomerIds = [], validFrom, validUntil = null } = data;
    if (!code || !name || !discountType || discountValue === undefined || !usageType || !validFrom) {
      throw new Error("code, name, discountType, discountValue, usageType, and validFrom are required.");
    }
    if (!config.discountTypes.includes(discountType)) throw new Error(`Invalid discountType "${discountType}".`);
    if (!config.couponUsageTypes.includes(usageType)) throw new Error(`Invalid usageType "${usageType}".`);

    const normalizedCode = code.toUpperCase().trim();
    const existing = await CouponModel.findOne({ tenantId, code: normalizedCode }).lean();
    if (existing) throw new Error(`Coupon code "${normalizedCode}" already exists.`);

    const coupon = await CouponModel.create({
      tenantId, code: normalizedCode, name, discountType, discountValue, usageType, usageLimit, perCustomerLimit,
      applicableProductCodes: applicableProductCodes.map((c) => c.toUpperCase()), applicableCustomerIds,
      validFrom: new Date(validFrom), validUntil: validUntil ? new Date(validUntil) : null, status: "Active",
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.pricing.create_coupon", module: "Finance", resource: "Coupon", resourceId: coupon._id.toString(), userId: userId || null, tenantId, details: { code: normalizedCode } });

    return coupon.toJSON();
  }

  static async listCoupons(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    return CouponModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async revokeCoupon(couponId, data, tenantId, userId) {
    const coupon = await CouponModel.findOne({ _id: couponId, tenantId });
    if (!coupon) throw new Error("Coupon not found.");
    if (coupon.status !== "Active") throw new Error(`Cannot revoke a coupon in status "${coupon.status}".`);

    coupon.status = "Revoked";
    coupon.revokedReason = data?.reason || null;
    coupon.updatedBy = userId || null;
    await coupon.save();

    await AuditLogModel.create({ action: "finance.pricing.revoke_coupon", module: "Finance", resource: "Coupon", resourceId: coupon._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });

    return coupon.toJSON();
  }

  static async _applyCoupon(couponCode, { customerId, productCodes, currentAmount, tenantId, asOfDate, redeem, transactionRef, userId }) {
    const coupon = await CouponModel.findOne({ tenantId, code: couponCode.toUpperCase().trim() });
    if (!coupon) throw new Error(`Coupon "${couponCode}" not found.`);

    const { valid, reason } = isCouponValid(coupon.toObject(), { customerId, productCodes, asOfDate });
    if (!valid) throw new Error(`Coupon "${couponCode}" cannot be applied: ${reason}`);

    const discountAmount = applyDiscount(currentAmount, coupon.discountType, coupon.discountValue);

    if (redeem && discountAmount > 0) {
      coupon.usedCount += 1;
      coupon.redemptions.push({ customerId, transactionRef, amount: discountAmount, redeemedAt: new Date() });
      const maxUses = coupon.usageType === "SingleUse" ? 1 : coupon.usageLimit;
      if (maxUses !== null && maxUses !== undefined && coupon.usedCount >= maxUses) coupon.status = "Exhausted";
      coupon.updatedBy = userId || null;
      await coupon.save();

      publishEvent("CouponRedeemed", { tenantId, couponId: coupon._id.toString(), code: coupon.code, customerId: customerId?.toString() || null, discountAmount, performedBy: userId || null });
    }

    return { discountAmount, couponId: coupon._id };
  }

  // ---- Main Calculate ----

  /**
   * POST /api/v1/pricing/calculate
   * Resolve Price List -> Resolve Contract Price -> Apply Volume Rules ->
   * Apply Promotions -> Apply Coupons -> Apply Loyalty Rules -> Apply
   * Taxes -> Return Final Price. Persists one immutable
   * PriceCalculationModel row and publishes FinalPriceCalculated — the
   * real, callable Pricing & Discount Engine every module should ask,
   * per this Part's own opening principle.
   */
  static async calculatePrice(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { customerId = null, currency, items, couponCode = null, redeemCoupon = false, transactionRef = null, asOfDate } = data;

    if (!currency) throw new Error("currency is required.");
    if (!Array.isArray(items) || items.length === 0) throw new Error("items must be a non-empty array.");

    const date = asOfDate ? new Date(asOfDate) : new Date();
    const customer = customerId ? await CustomerModel.findOne({ _id: customerId, tenantId }).lean() : null;
    const customerGroup = customer?.category || null;

    const computedLines = [];
    for (const item of items) {
      const productCode = (item.productCode || item.productId || "").toString().toUpperCase();
      const quantity = Number(item.quantity);
      if (!productCode) throw new Error("Each item requires a productCode (or productId).");
      if (!(quantity > 0)) throw new Error(`Item "${productCode}": quantity must be greater than zero.`);

      const basePriceResult = await PricingService.resolveBasePrice({ productCode, customerId, customerGroup, currency, tenantId, asOfDate: date, fallbackUnitPrice: item.unitPrice ?? null });
      const discountResult = await PricingService._calculateLineDiscounts({ productCode, customerId, customerGroup, quantity, basePrice: basePriceResult.unitPrice, tenantId, asOfDate: date });

      computedLines.push({
        productCode, quantity, basePrice: basePriceResult.unitPrice, priceListId: basePriceResult.priceListId,
        contractRuleId: basePriceResult.source === "Contract" ? basePriceResult.ruleId : null,
        appliedRules: discountResult.appliedRules, taxCode: item.taxCode || null,
        lineSubtotal: discountResult.lineSubtotal, discountAmount: discountResult.discountAmount, runningTotal: discountResult.lineTotalAfterRules
      });
    }

    const subtotal = roundCurrency(computedLines.reduce((sum, l) => sum + l.lineSubtotal, 0));
    const ruleDiscountTotal = roundCurrency(computedLines.reduce((sum, l) => sum + l.discountAmount, 0));
    let runningDocumentTotal = roundCurrency(computedLines.reduce((sum, l) => sum + l.runningTotal, 0));

    // "Apply Coupons" — document-level; when the coupon is product-specific,
    // the discount is computed against only the eligible lines' own
    // running total, not the whole order.
    let couponDiscountAmount = 0;
    let couponRecord = null;
    if (couponCode) {
      const productCodes = computedLines.map((l) => l.productCode);
      const coupon = await CouponModel.findOne({ tenantId, code: couponCode.toUpperCase().trim() }).lean();
      const eligibleLines = coupon?.applicableProductCodes?.length > 0 ? computedLines.filter((l) => coupon.applicableProductCodes.includes(l.productCode)) : computedLines;
      const eligibleAmount = roundCurrency(eligibleLines.reduce((sum, l) => sum + l.runningTotal, 0));

      const result = await PricingService._applyCoupon(couponCode, { customerId, productCodes, currentAmount: eligibleAmount, tenantId, asOfDate: date, redeem: redeemCoupon, transactionRef, userId });
      couponDiscountAmount = result.discountAmount;
      couponRecord = { couponId: result.couponId, code: couponCode.toUpperCase().trim() };

      const weights = eligibleLines.map((l) => l.runningTotal);
      const allocations = allocateProportionally(couponDiscountAmount, weights);
      eligibleLines.forEach((line, i) => { line.runningTotal = roundCurrency(line.runningTotal - allocations[i]); line._couponAllocation = allocations[i]; });
      runningDocumentTotal = roundCurrency(runningDocumentTotal - couponDiscountAmount);
    }

    // "Apply Loyalty Rules" — real, but scoped to customers already in the
    // configured loyalty category (Customer.category, Part 1) — no
    // separate points-balance system exists to build a richer engine
    // against (see utils/financeConfig.js's own doc comment).
    let loyaltyDiscountAmount = 0;
    if (customer?.category === config.loyaltyCustomerCategory) {
      const loyaltyCandidates = await PricingService._resolveApplicableRules(tenantId, { ruleType: "Loyalty", customerId, customerGroup, productCode: null, asOfDate: date });
      const loyaltyRule = selectBestRule(loyaltyCandidates);
      if (loyaltyRule && loyaltyRule.discountType) {
        loyaltyDiscountAmount = applyDiscount(runningDocumentTotal, loyaltyRule.discountType, loyaltyRule.discountValue);
        if (loyaltyDiscountAmount > 0) {
          const weights = computedLines.map((l) => l.runningTotal);
          const allocations = allocateProportionally(loyaltyDiscountAmount, weights);
          computedLines.forEach((line, i) => {
            line.runningTotal = roundCurrency(line.runningTotal - allocations[i]);
            line.appliedRules.push({ ruleId: loyaltyRule._id, ruleType: "Loyalty", description: loyaltyRule.ruleName, discountAmount: allocations[i] });
          });
          runningDocumentTotal = roundCurrency(runningDocumentTotal - loyaltyDiscountAmount);
        }
      }
    }

    // "Apply Taxes" — real integration with the Part 20 Tax Engine, only
    // when a customerCountry can genuinely be resolved (the customer's
    // own real address.country) — skipped, never fabricated, otherwise.
    let taxTotal = 0;
    const country = customer?.address?.country || null;
    if (country) {
      try {
        const taxResult = await TaxService.calculateTax({
          customerCountry: country, customerState: customer?.address?.state || null, transactionType: "Custom", direction: "Output",
          currency, lines: computedLines.map((l) => ({ amount: l.runningTotal, taxCode: l.taxCode })), partyType: "customer", partyId: customerId, asOfDate: date
        }, tenantId, userId);
        taxTotal = taxResult.documentTaxTotal;
        taxResult.lines.forEach((taxLine, i) => { computedLines[i].taxAmount = taxLine.reverseCharge ? 0 : taxLine.taxAmount; });
      } catch {
        taxTotal = 0; // No matching tax rule / not configured — skip rather than block pricing.
      }
    }

    const discountTotal = roundCurrency(ruleDiscountTotal + couponDiscountAmount + loyaltyDiscountAmount);
    const grandTotal = roundCurrency(runningDocumentTotal + taxTotal);

    const record = await PriceCalculationModel.create({
      tenantId, customerId, currency, transactionRef,
      lines: computedLines.map((l) => ({
        productCode: l.productCode, quantity: l.quantity, basePrice: l.basePrice, priceListId: l.priceListId, contractRuleId: l.contractRuleId,
        appliedRules: l.appliedRules, couponCode: couponRecord?.code || null, couponDiscountAmount: roundCurrency(l._couponAllocation || 0),
        discountAmount: roundCurrency(l.discountAmount + (l._couponAllocation || 0)), taxAmount: roundCurrency(l.taxAmount || 0),
        finalUnitPrice: l.quantity > 0 ? roundCurrency(l.runningTotal / l.quantity) : l.basePrice, lineTotal: roundCurrency(l.runningTotal + (l.taxAmount || 0))
      })),
      subtotal, discountTotal, taxTotal, grandTotal, performedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.pricing.calculate", module: "Finance", resource: "PriceCalculation", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { subtotal, discountTotal, grandTotal } });
    publishEvent("FinalPriceCalculated", { tenantId, calculationId: record._id.toString(), customerId: customerId?.toString() || null, currency, grandTotal, performedBy: userId || null });
    if (discountTotal > 0) publishEvent("DiscountApplied", { tenantId, calculationId: record._id.toString(), discountTotal, performedBy: userId || null });

    return record.toJSON();
  }

  // ---- Price Lists ----

  static async createPriceList(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { name, listType, currency, customerId = null, customerGroup = null, isDefault = false } = data;
    if (!name || !listType || !currency) throw new Error("name, listType, and currency are required.");

    if (isDefault) await PriceListModel.updateMany({ tenantId, currency: currency.toUpperCase(), isDefault: true }, { $set: { isDefault: false } });

    const priceList = await PriceListModel.create({
      tenantId, name, listType, currency: currency.toUpperCase(), customerId, customerGroup, isDefault, status: "Active",
      timeline: [{ event: "PriceListCreated", description: `${listType} price list "${name}" created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.pricing.create_price_list", module: "Finance", resource: "PriceList", resourceId: priceList._id.toString(), userId: userId || null, tenantId, details: { name, listType } });

    return priceList.toJSON();
  }

  static async listPriceLists(query, tenantId) {
    const filter = { tenantId };
    if (query.currency) filter.currency = query.currency.toUpperCase();
    if (query.status) filter.status = query.status;
    return PriceListModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async upsertPriceListEntry(priceListId, data, tenantId, userId) {
    const { productCode, unitPrice } = data;
    if (!productCode || unitPrice === undefined || unitPrice === null) throw new Error("productCode and unitPrice are required.");

    const priceList = await PriceListModel.findOne({ _id: priceListId, tenantId }).lean();
    if (!priceList) throw new Error("Price list not found.");

    const entry = await PriceListEntryModel.findOneAndUpdate(
      { tenantId, priceListId, productCode: productCode.toUpperCase() },
      { $set: { unitPrice, updatedBy: userId || null }, $setOnInsert: { createdBy: userId || null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await AuditLogModel.create({ action: "finance.pricing.upsert_price_list_entry", module: "Finance", resource: "PriceListEntry", resourceId: entry._id.toString(), userId: userId || null, tenantId, details: { priceListId, productCode: productCode.toUpperCase(), unitPrice } });

    return entry.toJSON();
  }

  static async listPriceListEntries(priceListId, tenantId) {
    return PriceListEntryModel.find({ tenantId, priceListId }).sort({ productCode: 1 }).lean();
  }
}

export default PricingService;
