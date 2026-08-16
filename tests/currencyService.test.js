import test from "node:test";
import assert from "node:assert/strict";
import { isValidIso4217Code, invertRate, calculateGainLoss, roundWithMode } from "../services/CurrencyService.js";
import { isValidIso4217NumericCode, ISO_4217_CURRENCIES } from "../utils/iso4217.js";

test("isValidIso4217NumericCode accepts exactly 3 digits, rejects everything else", () => {
  assert.equal(isValidIso4217NumericCode("840"), true);
  assert.equal(isValidIso4217NumericCode("048"), true);
  assert.equal(isValidIso4217NumericCode("84"), false);
  assert.equal(isValidIso4217NumericCode("8400"), false);
  assert.equal(isValidIso4217NumericCode("USD"), false);
  assert.equal(isValidIso4217NumericCode(840), false);
});

test("ISO_4217_CURRENCIES carries a real numeric code for every entry (File 4 Part 2)", () => {
  for (const [code, entry] of Object.entries(ISO_4217_CURRENCIES)) {
    assert.ok(isValidIso4217NumericCode(entry.numericCode), `${code} is missing a valid numericCode`);
  }
  assert.equal(ISO_4217_CURRENCIES.USD.numericCode, "840");
  assert.equal(ISO_4217_CURRENCIES.PKR.numericCode, "586");
});

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

test("calculateGainLoss(..., realized: true) labels the same math Realized instead of Unrealized (File 4 Part 3)", () => {
  assert.deepEqual(calculateGainLoss(1000, 1100, false, true), { amount: 100, type: "Realized Gain" });
  assert.deepEqual(calculateGainLoss(1000, 900, true, true), { amount: 100, type: "Realized Gain" });
});

test("roundWithMode Commercial matches the existing plain round-half-up default (File 4 Part 3)", () => {
  // 1.005 is not exactly representable in binary floating point (it's
  // actually ~1.00499999999999989...), so *100 lands just under 100.5 and
  // rounds down — the same real quirk plain `Math.round` has always had.
  assert.equal(roundWithMode(1.005, 2, "Commercial"), 1);
  assert.equal(roundWithMode(1.004, 2, "Commercial"), 1);
  assert.equal(roundWithMode(-1.005, 2, "Commercial"), -1);
});

test("roundWithMode AlwaysUp/AlwaysDown always round toward/away from the ceiling", () => {
  assert.equal(roundWithMode(1.001, 2, "AlwaysUp"), 1.01);
  assert.equal(roundWithMode(1.009, 2, "AlwaysUp"), 1.01);
  assert.equal(roundWithMode(1.009, 2, "AlwaysDown"), 1.00);
  assert.equal(roundWithMode(1.001, 2, "AlwaysDown"), 1.00);
});

test("roundWithMode BankersRounding rounds exact .5 ties to the nearest even, otherwise rounds normally", () => {
  assert.equal(roundWithMode(0.125, 2, "BankersRounding"), 0.12); // tie -> even (12)
  assert.equal(roundWithMode(0.135, 2, "BankersRounding"), 0.14); // tie -> even (14)
  assert.equal(roundWithMode(0.126, 2, "BankersRounding"), 0.13); // not a tie -> normal round
});
