import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDebitLineTotals,
  computeDebitNoteTotals,
  isDebitNoteApprovable,
  isDebitNoteIssuable,
  isDebitNoteAllocatable,
  isDebitNoteCancellable,
  isDebitNoteVoidable,
  isDebitNoteCloseable
} from "../services/DebitNoteService.js";

const TAX_CODES = [
  { code: "VAT", rate: 0.15, label: "VAT 15%" },
  { code: "ZERO", rate: 0, label: "Zero-Rated" }
];

test("computeDebitLineTotals computes tax from a caller-supplied taxCode (no original line to reference)", () => {
  const result = computeDebitLineTotals({ description: "Urgent Processing", amount: 150, taxCode: "VAT" }, TAX_CODES);
  assert.equal(result.amount, 150);
  assert.equal(result.taxCode, "VAT");
  assert.equal(result.taxAdjustment, 22.5);
  assert.equal(result.lineTotal, 172.5);
});

test("computeDebitLineTotals applies zero tax when no taxCode is supplied", () => {
  const result = computeDebitLineTotals({ description: "Late Fee", amount: 50 }, TAX_CODES);
  assert.equal(result.taxCode, null);
  assert.equal(result.taxAdjustment, 0);
  assert.equal(result.lineTotal, 50);
});

test("computeDebitLineTotals rejects a non-positive amount", () => {
  assert.throws(() => computeDebitLineTotals({ description: "X", amount: 0 }, TAX_CODES), /amount must be greater than zero/);
});

test("computeDebitLineTotals rejects a missing description", () => {
  assert.throws(() => computeDebitLineTotals({ amount: 50 }, TAX_CODES), /requires a description/);
});

test("computeDebitLineTotals rejects an unknown taxCode", () => {
  assert.throws(() => computeDebitLineTotals({ description: "X", amount: 50, taxCode: "BOGUS" }, TAX_CODES), /Unknown taxCode/);
});

test("computeDebitNoteTotals sums multiple computed line items", () => {
  const lines = [
    computeDebitLineTotals({ description: "A", amount: 500, taxCode: "VAT" }, TAX_CODES),
    computeDebitLineTotals({ description: "B", amount: 100, taxCode: "ZERO" }, TAX_CODES)
  ];
  const totals = computeDebitNoteTotals(lines);
  assert.equal(totals.debitAmount, 600);
  assert.equal(totals.taxAdjustmentTotal, 75);
  assert.equal(totals.grandTotal, 675);
});

test("debit note status predicates follow the Draft -> Approve -> Issue -> Allocate -> Close gating", () => {
  assert.equal(isDebitNoteApprovable("Draft"), true);
  assert.equal(isDebitNoteApprovable("Pending Approval"), true);
  assert.equal(isDebitNoteApprovable("Approved"), false);

  assert.equal(isDebitNoteIssuable("Approved", true), true);
  assert.equal(isDebitNoteIssuable("Draft", true), false);
  assert.equal(isDebitNoteIssuable("Draft", false), true);

  assert.equal(isDebitNoteAllocatable("Issued"), true);
  assert.equal(isDebitNoteAllocatable("Draft"), false);
  assert.equal(isDebitNoteAllocatable("Allocated"), false);

  assert.equal(isDebitNoteCancellable("Draft"), true);
  assert.equal(isDebitNoteCancellable("Approved"), true);
  assert.equal(isDebitNoteCancellable("Issued"), false);

  assert.equal(isDebitNoteVoidable("Issued"), true);
  assert.equal(isDebitNoteVoidable("Allocated"), false);
  assert.equal(isDebitNoteVoidable("Draft"), false);

  assert.equal(isDebitNoteCloseable("Allocated"), true);
  assert.equal(isDebitNoteCloseable("Issued"), false);
});
