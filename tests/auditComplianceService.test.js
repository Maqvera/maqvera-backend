import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEventHash,
  checkCreatorApproverConflict,
  findRoleConflicts,
  evaluateFieldChangeRestriction,
  evaluateCompliancePolicies
} from "../services/AuditComplianceService.js";

const baseEvent = () => ({
  tenantId: "t1",
  sequence: 1,
  module: "Finance",
  category: "Financial",
  entityType: "Invoice",
  entityId: "i1",
  userId: "u1",
  action: "Created",
  beforeState: null,
  afterState: { status: "Draft" },
  timestamp: "2026-08-10T10:00:00Z",
  previousHash: null
});

test("computeEventHash is a real, deterministic SHA-256 (64 hex chars) over the event's own evidentiary fields", () => {
  const hash = computeEventHash(baseEvent());
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(computeEventHash(baseEvent()), hash);
});

test("computeEventHash changes when any real evidentiary field changes, and chains via previousHash", () => {
  const h1 = computeEventHash(baseEvent());
  assert.notEqual(computeEventHash({ ...baseEvent(), action: "Updated" }), h1);
  assert.notEqual(computeEventHash({ ...baseEvent(), afterState: { status: "Approved" } }), h1);
  assert.notEqual(computeEventHash({ ...baseEvent(), previousHash: h1 }), h1);
});

test("checkCreatorApproverConflict flags the same real user as both creator and an approver, not a different one", () => {
  assert.equal(checkCreatorApproverConflict("u1", ["u1"]), true);
  assert.equal(checkCreatorApproverConflict("u1", ["u2", "u1"]), true);
  assert.equal(checkCreatorApproverConflict("u1", ["u2"]), false);
  assert.equal(checkCreatorApproverConflict(null, ["u1"]), false);
  assert.equal(checkCreatorApproverConflict("u1", []), false);
});

test("findRoleConflicts flags a real Role whose permissions grant both sides of a configured conflicting pair", () => {
  const roles = [
    { _id: "r1", name: "Conflicted", permissions: ["finance.journal.create", "finance.journal.approve", "finance.read"] },
    { _id: "r2", name: "Clean", permissions: ["finance.journal.create"] }
  ];
  const pairs = [["finance.journal.create", "finance.journal.approve"]];
  const flagged = findRoleConflicts(roles, pairs);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].roleName, "Conflicted");
});

test("evaluateFieldChangeRestriction flags a real change to a restricted field and ignores unrestricted ones", () => {
  const violations = evaluateFieldChangeRestriction({ accountCode: "1000", name: "Cash" }, { accountCode: "2000", name: "Cash" }, ["accountCode"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, "accountCode");
});

test("evaluateFieldChangeRestriction returns nothing when either real state is missing, never a fabricated violation", () => {
  assert.deepEqual(evaluateFieldChangeRestriction(null, { accountCode: "2000" }, ["accountCode"]), []);
  assert.deepEqual(evaluateFieldChangeRestriction({ accountCode: "1000" }, null, ["accountCode"]), []);
});

test("evaluateCompliancePolicies detects a real SegregationOfDuties violation directly from an event's own afterState", () => {
  const policies = [{ _id: "p1", name: "SoD", ruleType: "SegregationOfDuties", categories: [], entityTypes: [] }];
  const violations = evaluateCompliancePolicies({ category: "Financial", entityType: "Invoice", afterState: { createdBy: "u1", approvedBy: "u1" } }, policies);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].ruleType, "SegregationOfDuties");
});

test("evaluateCompliancePolicies stays silent when creator and approver are genuinely different real users", () => {
  const policies = [{ _id: "p1", name: "SoD", ruleType: "SegregationOfDuties", categories: [], entityTypes: [] }];
  const violations = evaluateCompliancePolicies({ category: "Financial", entityType: "Invoice", afterState: { createdBy: "u1", approvedBy: "u2" } }, policies);
  assert.deepEqual(violations, []);
});

test("evaluateCompliancePolicies scopes a policy by real category/entityType and skips out-of-scope events", () => {
  const policies = [{ _id: "p1", name: "Scoped", ruleType: "SegregationOfDuties", categories: ["Security"], entityTypes: [] }];
  const violations = evaluateCompliancePolicies({ category: "Financial", entityType: "Invoice", afterState: { createdBy: "u1", approvedBy: "u1" } }, policies);
  assert.deepEqual(violations, []);
});

test("evaluateCompliancePolicies detects a real FieldChangeRestriction violation from a policy's own configured fields", () => {
  const policies = [{ _id: "p1", name: "Field Guard", ruleType: "FieldChangeRestriction", categories: [], entityTypes: [], conditions: { restrictedFields: ["accountCode"] } }];
  const violations = evaluateCompliancePolicies({ category: "Financial", entityType: "ChartOfAccount", beforeState: { accountCode: "1000" }, afterState: { accountCode: "9999" } }, policies);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].ruleType, "FieldChangeRestriction");
});
