import test from "node:test";
import assert from "node:assert/strict";
import {
  isPricingRuleApprovable,
  isPricingRuleArchivable,
  rankRuleSpecificity,
  selectBestRule,
  selectBestVolumeTier,
  computeBuyXGetYDiscount,
  applyDiscount,
  isCouponValid,
  allocateProportionally
} from "../services/PricingService.js";

test("pricing rule status predicates follow the Draft -> Approved -> Expired/Archived gating", () => {
  assert.equal(isPricingRuleApprovable("Draft"), true);
  assert.equal(isPricingRuleApprovable("Approved"), false);

  assert.equal(isPricingRuleArchivable("Draft"), true);
  assert.equal(isPricingRuleArchivable("Approved"), true);
  assert.equal(isPricingRuleArchivable("Expired"), true);
  assert.equal(isPricingRuleArchivable("Superseded"), false);
});

test("rankRuleSpecificity ranks customerId > customerGroup > productCode > wildcard", () => {
  assert.equal(rankRuleSpecificity({ customerId: "x", customerGroup: "vip", productCode: "SKU1" }), 7);
  assert.equal(rankRuleSpecificity({ customerId: "x" }), 4);
  assert.equal(rankRuleSpecificity({ customerGroup: "vip" }), 2);
  assert.equal(rankRuleSpecificity({ productCode: "SKU1" }), 1);
  assert.equal(rankRuleSpecificity({}), 0);
});

test("selectBestRule prefers the most specific rule, then highest priority, then latest effectiveDate", () => {
  const candidates = [
    { customerId: null, customerGroup: "vip", productCode: null, priority: 0, effectiveDate: "2027-01-01" },
    { customerId: "cust-1", customerGroup: null, productCode: null, priority: 0, effectiveDate: "2027-01-01" }
  ];
  assert.equal(selectBestRule(candidates).customerId, "cust-1");

  const tiedSpecificity = [
    { customerGroup: "vip", priority: 1, effectiveDate: "2027-01-01" },
    { customerGroup: "vip", priority: 5, effectiveDate: "2027-01-01" }
  ];
  assert.equal(selectBestRule(tiedSpecificity).priority, 5);

  assert.equal(selectBestRule([]), null);
});

test("selectBestVolumeTier picks the highest qualifying quantity tier", () => {
  const tiers = [{ minQuantity: 1, discountType: "Percentage", discountValue: 0 }, { minQuantity: 10, discountType: "Percentage", discountValue: 5 }, { minQuantity: 50, discountType: "Percentage", discountValue: 10 }];
  assert.equal(selectBestVolumeTier(tiers, 25).discountValue, 5);
  assert.equal(selectBestVolumeTier(tiers, 100).discountValue, 10);
  assert.equal(selectBestVolumeTier(tiers, 0), null);
});

test("computeBuyXGetYDiscount gives free units only for full buy+get groups", () => {
  assert.equal(computeBuyXGetYDiscount(100, 7, 2, 1), 200); // 7/(2+1)=2 full groups -> 2 free units
  assert.equal(computeBuyXGetYDiscount(100, 2, 2, 1), 0); // no full group yet
  assert.equal(computeBuyXGetYDiscount(100, 9, 2, 1), 300); // 3 full groups
});

test("applyDiscount dispatches Percentage/FixedAmount/BuyXGetY, and returns 0 for a not-yet-implemented type", () => {
  assert.equal(applyDiscount(1000, "Percentage", 10), 100);
  assert.equal(applyDiscount(50, "FixedAmount", 100), 50); // capped at the base amount
  assert.equal(applyDiscount(1000, "FreeShipping", 0), 0);
});

test("isCouponValid rejects an inactive, not-yet-valid, expired, exhausted, or scope-mismatched coupon", () => {
  const base = { status: "Active", validFrom: "2027-01-01", validUntil: "2027-12-31", usageType: "MultiUse", usageLimit: 10, usedCount: 0, redemptions: [], applicableCustomerIds: [], applicableProductCodes: [] };
  assert.equal(isCouponValid(base, { asOfDate: new Date("2027-06-01") }).valid, true);
  assert.equal(isCouponValid({ ...base, status: "Revoked" }, { asOfDate: new Date("2027-06-01") }).valid, false);
  assert.equal(isCouponValid(base, { asOfDate: new Date("2026-06-01") }).valid, false); // before validFrom
  assert.equal(isCouponValid(base, { asOfDate: new Date("2028-06-01") }).valid, false); // after validUntil
  assert.equal(isCouponValid({ ...base, usageType: "SingleUse", usedCount: 1 }, { asOfDate: new Date("2027-06-01") }).valid, false);
  assert.equal(isCouponValid({ ...base, applicableProductCodes: ["SKU1"] }, { asOfDate: new Date("2027-06-01"), productCodes: ["SKU2"] }).valid, false);
});

test("allocateProportionally splits a total by weight with the rounding remainder landing on the last entry", () => {
  const allocations = allocateProportionally(100, [1, 1, 1]);
  assert.deepEqual(allocations, [33.33, 33.33, 33.34]);
  assert.equal(allocations.reduce((sum, a) => sum + a, 0), 100);
});

test("allocateProportionally returns all zeros when every weight is zero", () => {
  assert.deepEqual(allocateProportionally(100, [0, 0]), [0, 0]);
});
