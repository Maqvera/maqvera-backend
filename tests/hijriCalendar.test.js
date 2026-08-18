import test from "node:test";
import assert from "node:assert/strict";
import { getCurrentMuharramPeriod, hasCrossedMuharramPeriod } from "../utils/hijriCalendar.js";

test("getCurrentMuharramPeriod resolves 1445 AH's period to start on 2023-07-19 (public Umm al-Qura reference date)", () => {
  const period = getCurrentMuharramPeriod(new Date("2023-08-01T00:00:00Z"));
  assert.equal(period.hijriYear, 1445);
  assert.equal(period.financialYear, "AH1445");
  assert.equal(period.periodStart.toISOString().slice(0, 10), "2023-07-19");
});

test("getCurrentMuharramPeriod returns a period that actually contains the input date", () => {
  const asOf = new Date("2026-01-15T00:00:00Z");
  const period = getCurrentMuharramPeriod(asOf);
  assert.ok(period.periodStart.getTime() <= asOf.getTime());
  assert.ok(asOf.getTime() < period.periodEnd.getTime());
});

test("getCurrentMuharramPeriod's periodEnd is the next cycle's periodStart (no gap, no overlap)", () => {
  const period = getCurrentMuharramPeriod(new Date("2024-01-01T00:00:00Z"));
  const nextPeriod = getCurrentMuharramPeriod(period.periodEnd);
  assert.equal(period.periodEnd.getTime(), nextPeriod.periodStart.getTime());
  assert.equal(nextPeriod.hijriYear, period.hijriYear + 1);
});

test("getCurrentMuharramPeriod throws on an invalid date", () => {
  assert.throws(() => getCurrentMuharramPeriod("not-a-date"));
});

test("hasCrossedMuharramPeriod is true when there is no prior period", () => {
  assert.equal(hasCrossedMuharramPeriod(null, new Date()), true);
});

test("hasCrossedMuharramPeriod is false while still inside the same cycle, true once past periodEnd", () => {
  const period = getCurrentMuharramPeriod(new Date("2024-06-01T00:00:00Z"));
  assert.equal(hasCrossedMuharramPeriod(period, new Date("2024-06-02T00:00:00Z")), false);
  assert.equal(hasCrossedMuharramPeriod(period, period.periodEnd), true);
});
