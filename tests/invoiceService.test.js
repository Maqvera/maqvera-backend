import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTaxRate,
  computeLineTotals,
  computeInvoiceTotals,
  isInvoiceEditable,
  isInvoiceApprovable,
  isInvoiceIssuable,
  isInvoiceCancellable,
  isInvoiceVoidable,
  isInvoiceCloseable
} from "../services/InvoiceService.js";

const TAX_CODES = [
  { code: "VAT", rate: 0.15, label: "VAT 15%" },
  { code: "ZERO", rate: 0, label: "Zero-Rated" }
];

test("resolveTaxRate returns 0 when no taxCode is given", () => {
  assert.equal(resolveTaxRate(null, TAX_CODES), 0);
  assert.equal(resolveTaxRate(undefined, TAX_CODES), 0);
});

test("resolveTaxRate looks up a configured code", () => {
  assert.equal(resolveTaxRate("VAT", TAX_CODES), 0.15);
});

test("resolveTaxRate rejects an unknown taxCode rather than silently treating it as 0%", () => {
  assert.throws(() => resolveTaxRate("BOGUS", TAX_CODES), /Unknown taxCode/);
});

test("computeLineTotals matches the spec's own worked example (2 x 250, VAT 15%)", () => {
  const result = computeLineTotals({ description: "USA Tourist Visa", quantity: 2, unitPrice: 250, taxCode: "VAT" }, TAX_CODES);
  assert.equal(result.lineSubtotal, 500);
  assert.equal(result.lineTaxAmount, 75);
  assert.equal(result.lineDiscountAmount, 0);
  assert.equal(result.lineTotal, 575);
});

test("computeLineTotals applies a percentage discount before tax", () => {
  const result = computeLineTotals({ description: "Package", quantity: 1, unitPrice: 1000, discountType: "Percentage", discountValue: 10, taxCode: "VAT" }, TAX_CODES);
  assert.equal(result.lineDiscountAmount, 100);
  assert.equal(result.lineTaxAmount, 135); // 15% of (1000 - 100)
  assert.equal(result.lineTotal, 1035);
});

test("computeLineTotals applies a flat discount", () => {
  const result = computeLineTotals({ description: "Service", quantity: 1, unitPrice: 500, discountType: "Flat", discountValue: 50, taxCode: "ZERO" }, TAX_CODES);
  assert.equal(result.lineDiscountAmount, 50);
  assert.equal(result.lineTotal, 450);
});

test("computeLineTotals rejects a discount larger than the line subtotal", () => {
  assert.throws(() => computeLineTotals({ description: "X", quantity: 1, unitPrice: 100, discountType: "Flat", discountValue: 200 }, TAX_CODES), /cannot exceed/);
});

test("computeLineTotals rejects a non-positive quantity", () => {
  assert.throws(() => computeLineTotals({ description: "X", quantity: 0, unitPrice: 100 }, TAX_CODES), /quantity must be greater than zero/);
});

test("computeInvoiceTotals sums multiple computed line items", () => {
  const lines = [
    computeLineTotals({ description: "A", quantity: 2, unitPrice: 250, taxCode: "VAT" }, TAX_CODES),
    computeLineTotals({ description: "B", quantity: 1, unitPrice: 100, taxCode: "ZERO" }, TAX_CODES)
  ];
  const totals = computeInvoiceTotals(lines);
  assert.equal(totals.subtotal, 600);
  assert.equal(totals.taxTotal, 75);
  assert.equal(totals.discountTotal, 0);
  assert.equal(totals.grandTotal, 675);
});

test("invoice status predicates follow the Draft -> Approve -> Issue gating", () => {
  assert.equal(isInvoiceEditable("Draft"), true);
  assert.equal(isInvoiceEditable("Issued"), false);

  assert.equal(isInvoiceApprovable("Draft"), true);
  assert.equal(isInvoiceApprovable("Pending Approval"), true);
  assert.equal(isInvoiceApprovable("Approved"), false);

  assert.equal(isInvoiceIssuable("Approved", true), true);
  assert.equal(isInvoiceIssuable("Draft", true), false);
  assert.equal(isInvoiceIssuable("Draft", false), true);

  assert.equal(isInvoiceCancellable("Approved"), true);
  assert.equal(isInvoiceCancellable("Issued"), false);

  assert.equal(isInvoiceVoidable("Issued"), true);
  assert.equal(isInvoiceVoidable("Draft"), false);

  assert.equal(isInvoiceCloseable("Paid"), true);
  assert.equal(isInvoiceCloseable("Issued"), false);
});
