import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidIban,
  isValidSwiftBic,
  isBusinessDay,
  nextBusinessDay,
  requiresDualApproval,
  requiredApprovalCount,
  hasEnoughApprovals,
  isVendorPaymentApprovable,
  isVendorPaymentRejectable,
  isVendorPaymentCancellable,
  isVendorPaymentHoldable,
  isVendorPaymentReleasable,
  isVendorPaymentSchedulable,
  isVendorPaymentExecutable,
  findDuplicatePayablePayments,
  checkFundAvailability
} from "../services/VendorPaymentService.js";

test("isValidIban accepts real, well-known valid IBANs (MOD-97-10 checksum)", () => {
  assert.equal(isValidIban("GB29NWBK60161331926819"), true);
  assert.equal(isValidIban("DE89370400440532013000"), true);
  assert.equal(isValidIban("FR1420041010050500013M02606"), true);
});

test("isValidIban rejects a tampered checksum digit and malformed input", () => {
  assert.equal(isValidIban("GB29NWBK60161331926818"), false);
  assert.equal(isValidIban("NOTANIBAN"), false);
  assert.equal(isValidIban(""), false);
});

test("findDuplicatePayablePayments flags an existing active proposal covering the same payable", () => {
  const existing = [
    { vendorPaymentNumber: "VPY-2027-000001", lineAllocations: [{ payableId: "p1" }, { payableId: "p2" }] },
    { vendorPaymentNumber: "VPY-2027-000002", lineAllocations: [{ payableId: "p3" }] }
  ];
  assert.deepEqual(findDuplicatePayablePayments(["p2"], existing), [existing[0]]);
  assert.deepEqual(findDuplicatePayablePayments(["p9"], existing), []);
  assert.deepEqual(findDuplicatePayablePayments(["p1", "p3"], existing), existing);
});

test("findDuplicatePayablePayments returns empty when no active proposals exist", () => {
  assert.deepEqual(findDuplicatePayablePayments(["p1"], []), []);
});

test("checkFundAvailability reports no shortfall when the balance covers the total", () => {
  assert.deepEqual(checkFundAvailability(1000, 500), { available: true, shortfall: 0 });
  assert.deepEqual(checkFundAvailability(500, 500), { available: true, shortfall: 0 });
});

test("checkFundAvailability computes a real shortfall when the balance is insufficient", () => {
  assert.deepEqual(checkFundAvailability(300, 500), { available: false, shortfall: 200 });
  assert.deepEqual(checkFundAvailability(null, 500), { available: false, shortfall: 500 });
});

test("isValidSwiftBic accepts real 8 and 11 character formats", () => {
  assert.equal(isValidSwiftBic("DEUTDEFF"), true);
  assert.equal(isValidSwiftBic("NWBKGB2LXXX"), true);
});

test("isValidSwiftBic rejects malformed codes", () => {
  assert.equal(isValidSwiftBic("123"), false);
  assert.equal(isValidSwiftBic("toolongtobevalidcode"), false);
});

test("isBusinessDay/nextBusinessDay roll weekends forward to Monday", () => {
  assert.equal(isBusinessDay("2027-04-30"), true); // Friday
  assert.equal(isBusinessDay("2027-05-01"), false); // Saturday
  assert.equal(isBusinessDay("2027-05-02"), false); // Sunday
  assert.equal(nextBusinessDay("2027-05-01").toISOString().slice(0, 10), "2027-05-03");
});

test("nextBusinessDay is a no-op when skipWeekends is disabled", () => {
  assert.equal(nextBusinessDay("2027-05-01", false).toISOString().slice(0, 10), "2027-05-01");
});

test("requiresDualApproval honors the configured threshold (0 = never)", () => {
  assert.equal(requiresDualApproval(50000, { vendorPaymentDualApprovalThreshold: 0 }), false);
  assert.equal(requiresDualApproval(50000, { vendorPaymentDualApprovalThreshold: 10000 }), true);
  assert.equal(requiresDualApproval(5000, { vendorPaymentDualApprovalThreshold: 10000 }), false);
});

test("requiredApprovalCount and hasEnoughApprovals mirror Part 15's dual-authorization design", () => {
  assert.equal(requiredApprovalCount(false), 1);
  assert.equal(requiredApprovalCount(true), 2);
  assert.equal(hasEnoughApprovals([{ approvedBy: "u1" }], 1), true);
  assert.equal(hasEnoughApprovals([{ approvedBy: "u1" }, { approvedBy: "u1" }], 2), false);
  assert.equal(hasEnoughApprovals([{ approvedBy: "u1" }, { approvedBy: "u2" }], 2), true);
});

test("vendor payment status predicates follow the Proposed -> Approved -> Scheduled -> Executing -> Completed gating", () => {
  assert.equal(isVendorPaymentApprovable("Proposed"), true);
  assert.equal(isVendorPaymentApprovable("Approved"), false);

  assert.equal(isVendorPaymentRejectable("Proposed"), true);
  assert.equal(isVendorPaymentRejectable("Approved"), false);

  assert.equal(isVendorPaymentCancellable("Proposed"), true);
  assert.equal(isVendorPaymentCancellable("On Hold"), true);
  assert.equal(isVendorPaymentCancellable("Completed"), false);

  assert.equal(isVendorPaymentHoldable("Approved"), true);
  assert.equal(isVendorPaymentHoldable("Scheduled"), true);
  assert.equal(isVendorPaymentHoldable("Proposed"), false);

  assert.equal(isVendorPaymentReleasable("On Hold"), true);
  assert.equal(isVendorPaymentReleasable("Approved"), false);

  assert.equal(isVendorPaymentSchedulable("Approved"), true);
  assert.equal(isVendorPaymentSchedulable("Proposed"), false);

  assert.equal(isVendorPaymentExecutable("Scheduled"), true);
  assert.equal(isVendorPaymentExecutable("Approved"), false);
});
