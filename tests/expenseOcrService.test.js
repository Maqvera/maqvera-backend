import test from "node:test";
import assert from "node:assert/strict";
import { extractAmountFromText, extractDateFromText, extractVendorFromText } from "../services/ExpenseOcrService.js";

test("extractAmountFromText prefers a labeled Total over a Subtotal line (regression: 'Subtotal' contains 'total' as a substring)", () => {
  const text = "Subtotal: 100.00\nTax: 15.00\nTotal: 115.00";
  assert.equal(extractAmountFromText(text), 115);
});

test("extractAmountFromText recognizes Grand Total and Amount Due labels", () => {
  assert.equal(extractAmountFromText("Grand Total: 250.75"), 250.75);
  assert.equal(extractAmountFromText("Amount Due: $89.99"), 89.99);
});

test("extractAmountFromText falls back to the largest currency-shaped number when no label is found", () => {
  assert.equal(extractAmountFromText("Item A 12.50\nItem B 45.00\nItem C 8.25"), 45);
});

test("extractAmountFromText returns null when no amount-shaped text exists", () => {
  assert.equal(extractAmountFromText("Thank you for shopping with us"), null);
  assert.equal(extractAmountFromText(""), null);
  assert.equal(extractAmountFromText(null), null);
});

test("extractDateFromText recognizes ISO dates", () => {
  const date = extractDateFromText("Receipt Date: 2027-04-15\nStore #123");
  assert.equal(date.toISOString().slice(0, 10), "2027-04-15");
});

test("extractDateFromText recognizes MM/DD/YYYY slash dates", () => {
  const date = extractDateFromText("Date: 04/15/2027");
  assert.equal(date.toISOString().slice(0, 10), "2027-04-15");
});

test("extractDateFromText returns null when no recognizable date exists", () => {
  assert.equal(extractDateFromText("No date here"), null);
});

test("extractVendorFromText returns the first non-empty line", () => {
  assert.equal(extractVendorFromText("Marriott Hotel\n123 Main St\nTotal: 350.00"), "Marriott Hotel");
  assert.equal(extractVendorFromText("\n\nStarbucks\nCoffee: 4.50"), "Starbucks");
});

test("extractVendorFromText returns null for empty text", () => {
  assert.equal(extractVendorFromText(""), null);
  assert.equal(extractVendorFromText(null), null);
});
