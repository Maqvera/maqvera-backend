import test from "node:test";
import assert from "node:assert/strict";
import { isWalletUsable, hasSufficientBalance } from "../services/WalletService.js";

test("isWalletUsable only allows Active", () => {
  assert.equal(isWalletUsable("Active"), true);
  assert.equal(isWalletUsable("Suspended"), false);
  assert.equal(isWalletUsable("Closed"), false);
});

test("hasSufficientBalance compares rounded amounts", () => {
  assert.equal(hasSufficientBalance(100, 100), true);
  assert.equal(hasSufficientBalance(100.004, 100), true);
  assert.equal(hasSufficientBalance(99.99, 100), false);
});
