import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  computeHierarchyFields,
  wouldCreateCycle,
  assertWithinMaxDepth,
  recomputeDescendantPath,
  assertCanDeactivate,
  assertCanMerge,
  assertValidRevenueRecognition
} from "../services/ChartOfAccountService.js";

const oid = () => new mongoose.Types.ObjectId();

test("computeHierarchyFields returns root-level fields when there is no parent", () => {
  const { level, ancestors } = computeHierarchyFields(null);
  assert.equal(level, 0);
  assert.deepEqual(ancestors, []);
});

test("computeHierarchyFields extends the parent's ancestor chain", () => {
  const grandparentId = oid();
  const parentId = oid();
  const parent = { _id: parentId, level: 1, ancestors: [grandparentId] };

  const { level, ancestors } = computeHierarchyFields(parent);

  assert.equal(level, 2);
  assert.deepEqual(ancestors, [grandparentId, parentId]);
});

test("wouldCreateCycle flags an account being reparented under itself", () => {
  const accountId = oid();
  assert.equal(wouldCreateCycle(accountId, accountId, []), true);
});

test("wouldCreateCycle flags reparenting under one of the account's own descendants", () => {
  const accountId = oid();
  const descendantId = oid();
  // descendantId's ancestor chain includes accountId, so accountId cannot
  // become a child of descendantId without creating a cycle.
  assert.equal(wouldCreateCycle(accountId, descendantId, [accountId]), true);
});

test("wouldCreateCycle allows reparenting under an unrelated account", () => {
  const accountId = oid();
  const unrelatedId = oid();
  assert.equal(wouldCreateCycle(accountId, unrelatedId, [oid(), oid()]), false);
});

test("assertWithinMaxDepth rejects a level beyond the configured maximum", () => {
  assert.throws(() => assertWithinMaxDepth(11, 10), /maximum allowed depth/);
});

test("assertWithinMaxDepth allows a level at or below the maximum", () => {
  assert.doesNotThrow(() => assertWithinMaxDepth(10, 10));
});

test("recomputeDescendantPath rebuilds a grandchild's ancestors after its ancestor moves", () => {
  const oldRoot = oid();
  const accountId = oid();
  const childOfAccount = oid();
  const newRoot = oid();

  // Grandchild currently sits under: oldRoot -> accountId -> childOfAccount -> (self)
  const descendant = { ancestors: [oldRoot, accountId, childOfAccount], level: 3 };

  const result = recomputeDescendantPath(descendant, accountId, [newRoot], 1);

  assert.deepEqual(result.ancestors, [newRoot, accountId, childOfAccount]);
  assert.equal(result.level, 3);
});

test("assertCanDeactivate blocks system accounts", () => {
  assert.throws(() => assertCanDeactivate({ isSystemAccount: true, hasPostedTransactions: false }), /System accounts cannot be deleted/);
});

test("assertCanDeactivate blocks accounts with posted journal activity", () => {
  assert.throws(() => assertCanDeactivate({ isSystemAccount: false, hasPostedTransactions: true }), /journal entries cannot be removed/);
});

test("assertCanDeactivate allows an ordinary, untouched account", () => {
  assert.doesNotThrow(() => assertCanDeactivate({ isSystemAccount: false, hasPostedTransactions: false }));
});

test("assertCanMerge (Part 36) blocks merging an account into itself", () => {
  const id = oid();
  const account = { _id: id, isSystemAccount: false, hasPostedTransactions: false };
  assert.throws(() => assertCanMerge(account, account), /cannot be merged into itself/);
});

test("assertCanMerge blocks merging a system account away", () => {
  const source = { _id: oid(), isSystemAccount: true, hasPostedTransactions: false };
  const target = { _id: oid(), isSystemAccount: false, hasPostedTransactions: false, status: "Active" };
  assert.throws(() => assertCanMerge(source, target), /System accounts cannot be merged away/);
});

test("assertCanMerge blocks merging a source with posted journal history — no immutable history is ever reassigned", () => {
  const source = { _id: oid(), isSystemAccount: false, hasPostedTransactions: true };
  const target = { _id: oid(), isSystemAccount: false, hasPostedTransactions: false, status: "Active" };
  assert.throws(() => assertCanMerge(source, target), /journal entries cannot be merged/);
});

test("assertCanMerge requires the target account to be Active", () => {
  const source = { _id: oid(), isSystemAccount: false, hasPostedTransactions: false };
  const target = { _id: oid(), isSystemAccount: false, hasPostedTransactions: false, status: "Inactive", accountCode: "1999" };
  assert.throws(() => assertCanMerge(source, target), /must be Active to receive a merge/);
});

test("assertCanMerge allows an ordinary, untouched source into an Active target", () => {
  const source = { _id: oid(), isSystemAccount: false, hasPostedTransactions: false };
  const target = { _id: oid(), isSystemAccount: false, hasPostedTransactions: false, status: "Active" };
  assert.doesNotThrow(() => assertCanMerge(source, target));
});

const revenueRecognitionConfig = {
  deferredRevenueAccountTypes: ["Deferred Revenue", "Unearned Revenue", "Contract Liability"],
  revenueRecognitionMethods: ["Immediate", "Daily", "Monthly", "Milestone", "UsageBased", "PercentageCompletion"]
};

test("assertValidRevenueRecognition (Part 37) allows no revenueRecognition at all", () => {
  assert.doesNotThrow(() => assertValidRevenueRecognition({ category: "Expense", revenueRecognition: null }, revenueRecognitionConfig));
});

test("assertValidRevenueRecognition allows a deferredRevenueType on a Liabilities-category account", () => {
  assert.doesNotThrow(() => assertValidRevenueRecognition(
    { category: "Liabilities", revenueRecognition: { deferredRevenueType: "Deferred Revenue" } },
    revenueRecognitionConfig
  ));
});

test("assertValidRevenueRecognition rejects a deferredRevenueType on a non-Liabilities account", () => {
  assert.throws(
    () => assertValidRevenueRecognition({ category: "Revenue", revenueRecognition: { deferredRevenueType: "Deferred Revenue" } }, revenueRecognitionConfig),
    /can only be set on a Liabilities-category account/
  );
});

test("assertValidRevenueRecognition rejects an unconfigured deferredRevenueType", () => {
  assert.throws(
    () => assertValidRevenueRecognition({ category: "Liabilities", revenueRecognition: { deferredRevenueType: "Merchant Escrow" } }, revenueRecognitionConfig),
    /Invalid revenueRecognition.deferredRevenueType/
  );
});

test("assertValidRevenueRecognition rejects an unconfigured recognitionRule.method", () => {
  assert.throws(
    () => assertValidRevenueRecognition({ category: "Revenue", revenueRecognition: { recognitionRule: { method: "PerpetualLicense" } } }, revenueRecognitionConfig),
    /Invalid revenueRecognition.recognitionRule.method/
  );
});

test("assertValidRevenueRecognition allows a configured recognitionRule.method with no deferredRevenueType", () => {
  assert.doesNotThrow(() => assertValidRevenueRecognition(
    { category: "Revenue", revenueRecognition: { recognitionRule: { method: "Monthly", durationMonths: 12 } } },
    revenueRecognitionConfig
  ));
});
