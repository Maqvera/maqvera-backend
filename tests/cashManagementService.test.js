import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyVariance,
  isCashLocationCloseable,
  isCashLocationArchivable,
  isCashTransferApprovable,
  isCashTransferRejectable,
  isCashTransferCancellable,
  requiredApprovalCount,
  hasEnoughApprovals,
  isPettyCashAdvanceSettleable
} from "../services/CashManagementService.js";

test("classifyVariance returns None within tolerance, Shortage below expected, Overage above", () => {
  assert.equal(classifyVariance(0, 0), "None");
  assert.equal(classifyVariance(0.5, 1), "None");
  assert.equal(classifyVariance(-1500, 0), "Shortage");
  assert.equal(classifyVariance(250, 0), "Overage");
});

test("classifyVariance treats the tolerance as a symmetric band around zero", () => {
  assert.equal(classifyVariance(2, 5), "None");
  assert.equal(classifyVariance(-2, 5), "None");
  assert.equal(classifyVariance(6, 5), "Overage");
  assert.equal(classifyVariance(-6, 5), "Shortage");
});

test("cash location status predicates follow the Opened -> Closed -> Archived gating", () => {
  assert.equal(isCashLocationCloseable("Opened"), true);
  assert.equal(isCashLocationCloseable("Closed"), false);
  assert.equal(isCashLocationArchivable("Closed"), true);
  assert.equal(isCashLocationArchivable("Opened"), false);
});

test("cash transfer status predicates cover Pending Approval and Approved (dual-auth mid-state)", () => {
  assert.equal(isCashTransferApprovable("Pending Approval"), true);
  assert.equal(isCashTransferApprovable("Approved"), true);
  assert.equal(isCashTransferApprovable("Completed"), false);

  assert.equal(isCashTransferRejectable("Pending Approval"), true);
  assert.equal(isCashTransferRejectable("Completed"), false);

  assert.equal(isCashTransferCancellable("Approved"), true);
  assert.equal(isCashTransferCancellable("Rejected"), false);
});

test("requiredApprovalCount is 1 normally, 2 under dual authorization", () => {
  assert.equal(requiredApprovalCount(false), 1);
  assert.equal(requiredApprovalCount(true), 2);
});

test("hasEnoughApprovals counts only DISTINCT approvers — the same user twice never satisfies dual authorization", () => {
  assert.equal(hasEnoughApprovals([{ approvedBy: "user1" }], 1), true);
  assert.equal(hasEnoughApprovals([{ approvedBy: "user1" }], 2), false);
  assert.equal(hasEnoughApprovals([{ approvedBy: "user1" }, { approvedBy: "user1" }], 2), false);
  assert.equal(hasEnoughApprovals([{ approvedBy: "user1" }, { approvedBy: "user2" }], 2), true);
});

test("petty cash advance settleable only while Issued or Partially Settled", () => {
  assert.equal(isPettyCashAdvanceSettleable("Issued"), true);
  assert.equal(isPettyCashAdvanceSettleable("Partially Settled"), true);
  assert.equal(isPettyCashAdvanceSettleable("Settled"), false);
});
