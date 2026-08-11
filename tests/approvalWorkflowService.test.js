import test from "node:test";
import assert from "node:assert/strict";
import {
  isWorkflowDefinitionApprovable,
  isWorkflowDefinitionArchivable,
  evaluateConditions,
  resolveBranch,
  computeSignatureHash,
  evaluateApprovalProgress
} from "../services/ApprovalWorkflowService.js";

test("workflow definition status predicates follow the Draft -> Approved -> Expired/Archived gating", () => {
  assert.equal(isWorkflowDefinitionApprovable("Draft"), true);
  assert.equal(isWorkflowDefinitionApprovable("Approved"), false);
  assert.equal(isWorkflowDefinitionArchivable("Expired"), true);
  assert.equal(isWorkflowDefinitionArchivable("Superseded"), false);
});

test("evaluateConditions matches real amount/department/country/customerType operators", () => {
  assert.equal(evaluateConditions({ amountGreaterThan: 10000 }, { amount: 15000 }), true);
  assert.equal(evaluateConditions({ amountGreaterThan: 10000 }, { amount: 5000 }), false);
  assert.equal(evaluateConditions({ amountLessThanOrEqual: 500 }, { amount: 500 }), true);
  assert.equal(evaluateConditions({ department: "dept-1" }, { department: "dept-1" }), true);
  assert.equal(evaluateConditions({ department: "dept-1" }, { department: "dept-2" }), false);
  assert.equal(evaluateConditions({ country: "AE" }, { country: "ae" }), true);
  assert.equal(evaluateConditions({ customerType: "corporate" }, { customerType: "individual" }), false);
});

test("evaluateConditions treats an empty/missing conditions object as a universal match", () => {
  assert.equal(evaluateConditions({}, { amount: 1 }), true);
  assert.equal(evaluateConditions(null, { amount: 1 }), true);
});

test("resolveBranch picks the first matching Conditional branch, and passes through a non-Conditional definition unchanged", () => {
  const conditional = {
    approvalType: "Conditional",
    branches: [
      { conditions: { amountLessThan: 5000 }, approvalType: "AnyOne", levels: [{ levelName: "Manager" }] },
      { conditions: { amountGreaterThanOrEqual: 5000 }, approvalType: "Sequential", levels: [{ levelName: "Manager" }, { levelName: "CFO" }] }
    ]
  };
  assert.equal(resolveBranch(conditional, { amount: 1000 }).approvalType, "AnyOne");
  assert.equal(resolveBranch(conditional, { amount: 9000 }).approvalType, "Sequential");
  assert.throws(() => resolveBranch({ ...conditional, branches: [] }, { amount: 1 }), /No matching branch/);

  const direct = { approvalType: "Parallel", levels: [{ levelName: "Manager" }] };
  assert.deepEqual(resolveBranch(direct, {}), { approvalType: "Parallel", levels: direct.levels });
});

test("computeSignatureHash is deterministic for identical inputs and a real 64-char SHA-256 hex digest", () => {
  const input = { requestId: "r1", levelIndex: 0, approverId: "u1", decision: "Approved", timestamp: "2027-01-01T00:00:00.000Z" };
  const h1 = computeSignatureHash(input);
  const h2 = computeSignatureHash(input);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("computeSignatureHash changes when any input changes (non-repudiation)", () => {
  const base = { requestId: "r1", levelIndex: 0, approverId: "u1", decision: "Approved", timestamp: "2027-01-01T00:00:00.000Z" };
  const h1 = computeSignatureHash(base);
  const h2 = computeSignatureHash({ ...base, decision: "Rejected" });
  assert.notEqual(h1, h2);
});

test("evaluateApprovalProgress Sequential: advances level by level, any rejection anywhere rejects the whole request", () => {
  const levels = [
    { levelName: "Manager", order: 0, approverUserIds: ["u1"], minApprovals: 1 },
    { levelName: "CFO", order: 1, approverUserIds: ["u2"], minApprovals: 1 }
  ];
  assert.deepEqual(evaluateApprovalProgress("Sequential", levels, []), { complete: false, outcome: null, nextLevelIndex: 0 });
  const afterFirst = evaluateApprovalProgress("Sequential", levels, [{ approverId: "u1", levelIndex: 0, decision: "Approved" }]);
  assert.deepEqual(afterFirst, { complete: false, outcome: null, nextLevelIndex: 1 });
  const afterBoth = evaluateApprovalProgress("Sequential", levels, [{ approverId: "u1", levelIndex: 0, decision: "Approved" }, { approverId: "u2", levelIndex: 1, decision: "Approved" }]);
  assert.deepEqual(afterBoth, { complete: true, outcome: "Approved", nextLevelIndex: null });
  const rejected = evaluateApprovalProgress("Sequential", levels, [{ approverId: "u1", levelIndex: 0, decision: "Rejected" }]);
  assert.deepEqual(rejected, { complete: true, outcome: "Rejected", nextLevelIndex: null });
});

test("evaluateApprovalProgress Parallel: completes only once every level independently satisfies its own minApprovals", () => {
  const levels = [
    { levelName: "Finance", order: 0, approverUserIds: ["u1"], minApprovals: 1 },
    { levelName: "Legal", order: 1, approverUserIds: ["u2"], minApprovals: 1 }
  ];
  assert.equal(evaluateApprovalProgress("Parallel", levels, [{ approverId: "u1", levelIndex: 0, decision: "Approved" }]).complete, false);
  assert.equal(evaluateApprovalProgress("Parallel", levels, [{ approverId: "u1", levelIndex: 0, decision: "Approved" }, { approverId: "u2", levelIndex: 1, decision: "Approved" }]).complete, true);
});

test("evaluateApprovalProgress AnyOne: a single Approved completes immediately", () => {
  const levels = [{ levelName: "Committee", order: 0, approverUserIds: ["u1", "u2", "u3"], minApprovals: 1 }];
  assert.deepEqual(evaluateApprovalProgress("AnyOne", levels, [{ approverId: "u2", levelIndex: 0, decision: "Approved" }]), { complete: true, outcome: "Approved", nextLevelIndex: null });
});

test("evaluateApprovalProgress AllRequired: every assigned approver must approve; one rejection rejects", () => {
  const levels = [{ levelName: "Committee", order: 0, approverUserIds: ["u1", "u2"], minApprovals: 2 }];
  assert.equal(evaluateApprovalProgress("AllRequired", levels, [{ approverId: "u1", levelIndex: 0, decision: "Approved" }]).complete, false);
  assert.deepEqual(evaluateApprovalProgress("AllRequired", levels, [{ approverId: "u1", levelIndex: 0, decision: "Approved" }, { approverId: "u2", levelIndex: 0, decision: "Approved" }]), { complete: true, outcome: "Approved", nextLevelIndex: null });
  assert.deepEqual(evaluateApprovalProgress("AllRequired", levels, [{ approverId: "u1", levelIndex: 0, decision: "Rejected" }]), { complete: true, outcome: "Rejected", nextLevelIndex: null });
});

test("evaluateApprovalProgress MajorityVote: strict majority of assigned approvers decides the outcome", () => {
  const levels = [{ levelName: "Committee", order: 0, approverUserIds: ["a", "b", "c"], minApprovals: 1 }];
  assert.equal(evaluateApprovalProgress("MajorityVote", levels, [{ approverId: "a", levelIndex: 0, decision: "Approved" }]).complete, false);
  assert.deepEqual(evaluateApprovalProgress("MajorityVote", levels, [{ approverId: "a", levelIndex: 0, decision: "Approved" }, { approverId: "b", levelIndex: 0, decision: "Approved" }]), { complete: true, outcome: "Approved", nextLevelIndex: null });
  assert.deepEqual(evaluateApprovalProgress("MajorityVote", levels, [{ approverId: "a", levelIndex: 0, decision: "Rejected" }, { approverId: "b", levelIndex: 0, decision: "Rejected" }]), { complete: true, outcome: "Rejected", nextLevelIndex: null });
});
