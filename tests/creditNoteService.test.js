import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCreditLineTotals,
  computeCreditNoteTotals,
  computeRemainingCreditable,
  isCreditNoteApprovable,
  isCreditNoteIssuable,
  isCreditNoteAllocatable,
  isCreditNoteCancellable,
  isCreditNoteVoidable,
  isCreditNoteCloseable
} from "../services/CreditNoteService.js";

const TAX_CODES = [
  { code: "VAT", rate: 0.15, label: "VAT 15%" },
  { code: "ZERO", rate: 0, label: "Zero-Rated" }
];

test("computeCreditLineTotals recalculates tax from the ORIGINAL invoice line's taxCode, not a caller-supplied one", () => {
  const invoiceLine = { _id: "line1", description: "USA Tourist Visa", taxCode: "VAT" };
  const result = computeCreditLineTotals({ invoiceLineId: "line1", quantity: 1, amount: 250 }, invoiceLine, TAX_CODES);
  assert.equal(result.amount, 250);
  assert.equal(result.taxCode, "VAT");
  assert.equal(result.taxAdjustment, 37.5);
  assert.equal(result.lineTotal, 287.5);
});

test("computeCreditLineTotals applies zero tax when the original invoice line had no taxCode", () => {
  const invoiceLine = { _id: "line2", description: "Service Fee", taxCode: null };
  const result = computeCreditLineTotals({ invoiceLineId: "line2", quantity: 1, amount: 100 }, invoiceLine, TAX_CODES);
  assert.equal(result.taxAdjustment, 0);
  assert.equal(result.lineTotal, 100);
});

test("computeCreditLineTotals rejects a non-positive amount", () => {
  const invoiceLine = { _id: "line3", description: "X", taxCode: null };
  assert.throws(() => computeCreditLineTotals({ invoiceLineId: "line3", quantity: 1, amount: 0 }, invoiceLine, TAX_CODES), /amount must be greater than zero/);
});

test("computeCreditLineTotals rejects a non-positive quantity", () => {
  const invoiceLine = { _id: "line4", description: "X", taxCode: null };
  assert.throws(() => computeCreditLineTotals({ invoiceLineId: "line4", quantity: 0, amount: 50 }, invoiceLine, TAX_CODES), /quantity must be greater than zero/);
});

test("computeCreditNoteTotals sums multiple computed line items", () => {
  const lines = [
    computeCreditLineTotals({ invoiceLineId: "a", quantity: 2, amount: 500 }, { _id: "a", description: "A", taxCode: "VAT" }, TAX_CODES),
    computeCreditLineTotals({ invoiceLineId: "b", quantity: 1, amount: 100 }, { _id: "b", description: "B", taxCode: "ZERO" }, TAX_CODES)
  ];
  const totals = computeCreditNoteTotals(lines);
  assert.equal(totals.creditAmount, 600);
  assert.equal(totals.taxAdjustmentTotal, 75);
  assert.equal(totals.grandTotal, 675);
});

test("computeRemainingCreditable subtracts prior issued credit notes from the invoice total", () => {
  assert.equal(computeRemainingCreditable(1000, 0), 1000);
  assert.equal(computeRemainingCreditable(1000, 400), 600);
  assert.equal(computeRemainingCreditable(1000, 1000), 0);
});

test("credit note status predicates follow the Draft -> Approve -> Issue -> Allocate -> Close gating", () => {
  assert.equal(isCreditNoteApprovable("Draft"), true);
  assert.equal(isCreditNoteApprovable("Pending Approval"), true);
  assert.equal(isCreditNoteApprovable("Approved"), false);

  assert.equal(isCreditNoteIssuable("Approved", true), true);
  assert.equal(isCreditNoteIssuable("Draft", true), false);
  assert.equal(isCreditNoteIssuable("Draft", false), true);

  assert.equal(isCreditNoteAllocatable("Issued"), true);
  assert.equal(isCreditNoteAllocatable("Draft"), false);
  assert.equal(isCreditNoteAllocatable("Allocated"), false);

  assert.equal(isCreditNoteCancellable("Draft"), true);
  assert.equal(isCreditNoteCancellable("Approved"), true);
  assert.equal(isCreditNoteCancellable("Issued"), false);

  assert.equal(isCreditNoteVoidable("Issued"), true);
  assert.equal(isCreditNoteVoidable("Allocated"), false);
  assert.equal(isCreditNoteVoidable("Draft"), false);

  assert.equal(isCreditNoteCloseable("Allocated"), true);
  assert.equal(isCreditNoteCloseable("Issued"), false);
});
