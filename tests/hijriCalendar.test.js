import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment-hijri";
import { getCurrentMuharramPeriod, hasCrossedMuharramPeriod, getIslamicSeason } from "../utils/hijriCalendar.js";

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

// Boundary dates constructed directly from moment-hijri's own Hijri->Gregorian
// conversion (1446 AH, an arbitrary recent cycle) rather than hand-copied
// Gregorian dates — self-consistent against the same Umm al-Qura authority
// getIslamicSeason itself uses, not a second, independently-sourced calendar.
test("getIslamicSeason: real Ramadan/Hajj/regular boundaries (1446 AH)", () => {
  const ramadanStart = moment.utc("1446/9/1", "iYYYY/iM/iD").toDate();
  const ramadanMid = moment.utc("1446/9/15", "iYYYY/iM/iD").toDate();
  const ramadanEnd = moment.utc("1446/9/29", "iYYYY/iM/iD").toDate();
  const shawwalStart = moment.utc("1446/10/1", "iYYYY/iM/iD").toDate();
  const dhulHijjah1 = moment.utc("1446/12/1", "iYYYY/iM/iD").toDate();
  const hajjDay = moment.utc("1446/12/9", "iYYYY/iM/iD").toDate();
  const hajjLastDay = moment.utc("1446/12/13", "iYYYY/iM/iD").toDate();
  const dhulHijjah14 = moment.utc("1446/12/14", "iYYYY/iM/iD").toDate();
  const muharram1 = moment.utc("1446/1/1", "iYYYY/iM/iD").toDate();

  assert.equal(getIslamicSeason(ramadanStart), "Ramadan");
  assert.equal(getIslamicSeason(ramadanMid), "Ramadan");
  assert.equal(getIslamicSeason(ramadanEnd), "Ramadan");
  assert.equal(getIslamicSeason(shawwalStart), null, "the day after Ramadan ends must not still report Ramadan");
  assert.equal(getIslamicSeason(dhulHijjah1), "Hajj");
  assert.equal(getIslamicSeason(hajjDay), "Hajj");
  assert.equal(getIslamicSeason(hajjLastDay), "Hajj", "13 Dhul Hijjah is still inside the Hajj window");
  assert.equal(getIslamicSeason(dhulHijjah14), null, "14 Dhul Hijjah is past the Hajj window");
  assert.equal(getIslamicSeason(muharram1), null, "a regular month must report no season");
});

test("getIslamicSeason throws on an invalid date", () => {
  assert.throws(() => getIslamicSeason("not-a-date"));
});
