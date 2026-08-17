import test from "node:test";
import assert from "node:assert/strict";
import {
  isSubscriptionRenewable,
  isSubscriptionCancellable,
  isSubscriptionPausable,
  computeNextPeriodEnd,
  computeCycleAmount,
  computeProrationAmount
} from "../services/SubscriptionService.js";

test("isSubscriptionRenewable/Cancellable/Pausable follow the real status gating", () => {
  assert.equal(isSubscriptionRenewable("Trial"), true);
  assert.equal(isSubscriptionRenewable("Active"), true);
  assert.equal(isSubscriptionRenewable("PastDue"), true);
  assert.equal(isSubscriptionRenewable("Suspended"), false);
  assert.equal(isSubscriptionCancellable("Active"), true);
  assert.equal(isSubscriptionCancellable("Cancelled"), false);
  assert.equal(isSubscriptionCancellable("Terminated"), false);
  assert.equal(isSubscriptionPausable("Active"), true);
  assert.equal(isSubscriptionPausable("Trial"), false);
});

test("computeNextPeriodEnd rolls forward by the real cycle length", () => {
  assert.equal(computeNextPeriodEnd("2027-01-01", "Monthly").toISOString().slice(0, 10), "2027-02-01");
  assert.equal(computeNextPeriodEnd("2027-01-01", "Quarterly").toISOString().slice(0, 10), "2027-04-01");
  assert.equal(computeNextPeriodEnd("2027-01-01", "SemiAnnual").toISOString().slice(0, 10), "2027-07-01");
  assert.equal(computeNextPeriodEnd("2027-01-01", "Annual").toISOString().slice(0, 10), "2028-01-01");
  assert.equal(computeNextPeriodEnd("2027-01-01", "UsageBased").toISOString().slice(0, 10), "2027-02-01");
});

test("computeCycleAmount: flat for Subscription/Membership cycles, usage-derived for UsageBased/Metered, combined for Hybrid", () => {
  assert.equal(computeCycleAmount({ billingCycle: "Monthly", amount: 50, usage: { meteredQuantity: 0, meteredUnitPrice: 0 } }), 50);
  assert.equal(computeCycleAmount({ billingCycle: "UsageBased", amount: 50, usage: { meteredQuantity: 10, meteredUnitPrice: 2 } }), 20);
  assert.equal(computeCycleAmount({ billingCycle: "Metered", amount: 50, usage: { meteredQuantity: 5, meteredUnitPrice: 3 } }), 15);
  assert.equal(computeCycleAmount({ billingCycle: "Hybrid", amount: 50, usage: { meteredQuantity: 5, meteredUnitPrice: 3 } }), 65);
});

test("computeProrationAmount charges/credits proportionally to the unused fraction of the current period", () => {
  const periodStart = "2027-01-01T00:00:00.000Z";
  const periodEnd = "2027-02-01T00:00:00.000Z"; // 31 days
  const halfway = "2027-01-16T12:00:00.000Z"; // ~50% remaining
  const proration = computeProrationAmount(100, 200, periodStart, periodEnd, halfway);
  assert.ok(proration > 45 && proration < 55, `expected ~50, got ${proration}`);

  const downgrade = computeProrationAmount(200, 100, periodStart, periodEnd, halfway);
  assert.ok(downgrade < -45 && downgrade > -55, `expected ~-50, got ${downgrade}`);

  // Nothing left in the period -> no proration either way.
  assert.equal(computeProrationAmount(100, 200, periodStart, periodEnd, periodEnd), 0);
});
