import test from "node:test";
import assert from "node:assert/strict";
import { isValidIso4217Code, invertRate, calculateGainLoss } from "../services/CurrencyService.js";

test("isValidIso4217Code accepts real, known uppercase ISO 4217 codes", () => {
  assert.equal(isValidIso4217Code("USD"), true);
  assert.equal(isValidIso4217Code("PKR"), true);
  assert.equal(isValidIso4217Code("AED"), true);
});

test("isValidIso4217Code rejects lowercase, malformed, unknown, or non-string input", () => {
  assert.equal(isValidIso4217Code("usd"), false);
  assert.equal(isValidIso4217Code("US"), false);
  assert.equal(isValidIso4217Code("XXX"), false);
  assert.equal(isValidIso4217Code(123), false);
  assert.equal(isValidIso4217Code(null), false);
});

test("invertRate computes a real reciprocal", () => {
  assert.equal(invertRate(4), 0.25);
  assert.equal(invertRate(0.25), 4);
});

test("invertRate rejects a zero or negative rate rather than dividing by it", () => {
  assert.throws(() => invertRate(0), /zero or negative/);
  assert.throws(() => invertRate(-5), /zero or negative/);
});

test("calculateGainLoss for an asset (Bank/AR): base value rising is a Gain, falling is a Loss", () => {
  assert.deepEqual(calculateGainLoss(1000, 1100, false), { amount: 100, type: "Unrealized Gain" });
  assert.deepEqual(calculateGainLoss(1000, 900, false), { amount: 100, type: "Unrealized Loss" });
  assert.deepEqual(calculateGainLoss(1000, 1000, false), { amount: 0, type: null });
});

test("calculateGainLoss for a liability (AP): base value rising is a Loss, falling is a Gain — signs flip vs. an asset", () => {
  assert.deepEqual(calculateGainLoss(1000, 1100, true), { amount: 100, type: "Unrealized Loss" });
  assert.deepEqual(calculateGainLoss(1000, 900, true), { amount: 100, type: "Unrealized Gain" });
  assert.deepEqual(calculateGainLoss(1000, 1000, true), { amount: 0, type: null });
});
