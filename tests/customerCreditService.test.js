import test from "node:test";
import assert from "node:assert/strict";
import { isCreditUsable } from "../services/CustomerCreditService.js";

test("isCreditUsable requires Active status", () => {
  assert.equal(isCreditUsable({ status: "Consumed", expiresAt: null }), false);
  assert.equal(isCreditUsable({ status: "Expired", expiresAt: null }), false);
  assert.equal(isCreditUsable({ status: "Active", expiresAt: null }), true);
});

test("isCreditUsable treats a null expiresAt as never-expiring", () => {
  assert.equal(isCreditUsable({ status: "Active", expiresAt: null }, new Date("2030-01-01")), true);
});

test("isCreditUsable rejects an Active credit past its own expiresAt", () => {
  const referenceDate = new Date("2027-06-01");
  assert.equal(isCreditUsable({ status: "Active", expiresAt: "2027-05-01" }, referenceDate), false);
  assert.equal(isCreditUsable({ status: "Active", expiresAt: "2027-07-01" }, referenceDate), true);
});
