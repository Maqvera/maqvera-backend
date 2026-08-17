import test from "node:test";
import assert from "node:assert/strict";
import {
  isTaxRuleApprovable,
  isTaxRuleArchivable,
  selectMostSpecificRule,
  computeExclusiveTax,
  computeInclusiveTax,
  applyTaxCaps
} from "../services/TaxService.js";

test("tax rule status predicates follow the Draft -> Approved -> Expired/Archived gating", () => {
  assert.equal(isTaxRuleApprovable("Draft"), true);
  assert.equal(isTaxRuleApprovable("Approved"), false);

  assert.equal(isTaxRuleArchivable("Draft"), true);
  assert.equal(isTaxRuleArchivable("Approved"), true);
  assert.equal(isTaxRuleArchivable("Expired"), true);
  assert.equal(isTaxRuleArchivable("Superseded"), false);
  assert.equal(isTaxRuleArchivable("Archived"), false);
});

test("computeExclusiveTax adds tax on top of the base amount", () => {
  assert.equal(computeExclusiveTax(1000, 15), 150);
  assert.equal(computeExclusiveTax(250, 5), 12.5);
  assert.equal(computeExclusiveTax(1000, 0), 0);
});

test("computeInclusiveTax extracts the embedded tax and pre-tax basis from a gross amount", () => {
  const result = computeInclusiveTax(1150, 15);
  assert.equal(result.basis, 1000);
  assert.equal(result.taxAmount, 150);
  // Round-trips: basis + taxAmount reconstructs the original gross amount.
  assert.equal(result.basis + result.taxAmount, 1150);
});

test("applyTaxCaps clamps to the configured minimum/maximum, and is a no-op when both are null", () => {
  assert.equal(applyTaxCaps(5, 10, null), 10);
  assert.equal(applyTaxCaps(50, null, 20), 20);
  assert.equal(applyTaxCaps(15, 10, 20), 15);
  assert.equal(applyTaxCaps(15, null, null), 15);
});

test("selectMostSpecificRule prefers a state-specific rule over a country-generic one when the state matches", () => {
  const candidates = [
    { state: null, effectiveDate: "2027-01-01" },
    { state: "CA", effectiveDate: "2027-01-01" }
  ];
  assert.deepEqual(selectMostSpecificRule(candidates, "CA"), { state: "CA", effectiveDate: "2027-01-01" });
});

test("selectMostSpecificRule falls back to the country-generic rule when no state matches", () => {
  const candidates = [
    { state: null, effectiveDate: "2027-01-01" },
    { state: "CA", effectiveDate: "2027-01-01" }
  ];
  assert.deepEqual(selectMostSpecificRule(candidates, "TX"), { state: null, effectiveDate: "2027-01-01" });
});

test("selectMostSpecificRule picks the latest effectiveDate among rules of equal specificity", () => {
  const candidates = [
    { state: null, effectiveDate: "2027-01-01" },
    { state: null, effectiveDate: "2028-06-01" },
    { state: null, effectiveDate: "2027-06-01" }
  ];
  assert.equal(selectMostSpecificRule(candidates, null).effectiveDate, "2028-06-01");
});

test("selectMostSpecificRule returns null for an empty candidate list", () => {
  assert.equal(selectMostSpecificRule([], "CA"), null);
});
