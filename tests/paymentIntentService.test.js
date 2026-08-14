import test from "node:test";
import assert from "node:assert/strict";
import { isIntentConsumable, isIntentExpired } from "../services/PaymentIntentService.js";

test("isIntentConsumable allows Created/Pending/Waiting Customer/Authorized, blocks terminal states", () => {
  assert.equal(isIntentConsumable("Created"), true);
  assert.equal(isIntentConsumable("Pending"), true);
  assert.equal(isIntentConsumable("Waiting Customer"), true);
  assert.equal(isIntentConsumable("Authorized"), true);
  assert.equal(isIntentConsumable("Captured"), false);
  assert.equal(isIntentConsumable("Cancelled"), false);
  assert.equal(isIntentConsumable("Expired"), false);
  assert.equal(isIntentConsumable("Refunded"), false);
});

test("isIntentExpired is true only when expiresAt has passed AND nothing has been collected yet", () => {
  const now = new Date("2027-01-15T12:00:00Z");
  const expiredIntent = { expiresAt: new Date("2027-01-15T11:00:00Z") };
  const futureIntent = { expiresAt: new Date("2027-01-15T13:00:00Z") };

  assert.equal(isIntentExpired(expiredIntent, 0, now), true);
  assert.equal(isIntentExpired(futureIntent, 0, now), false);
  // Once real money has already been collected under this intent, expiry
  // no longer retroactively blocks collecting the remaining balance — the
  // Collection itself is the authoritative record from that point on.
  assert.equal(isIntentExpired(expiredIntent, 250, now), false);
  assert.equal(isIntentExpired({ expiresAt: null }, 0, now), false);
});
