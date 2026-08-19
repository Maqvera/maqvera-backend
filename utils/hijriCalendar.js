import moment from "moment-hijri";

// Muharram-to-Muharram annual accounting period math (booking-module PRD
// Part A item #5). Calendar authority: Umm al-Qura (Saudi Arabia's official
// calculated Hijri calendar) — confirmed with the business rather than
// guessed, since moon-sighting-based calendars vary by country and this
// directly determines real financial period boundaries. moment-hijri
// implements Umm al-Qura's tabular calculation, so no live moon-sighting
// dependency and no network call — deterministic and testable.
//
// Pure function, no DB access — unit-testable directly (same "pure
// text-parsing helpers" discipline services/ExpenseOcrService.js already
// established for this codebase).

/**
 * Resolves the Muharram-to-Muharram cycle containing `gregorianDate`.
 * `hijriYear` is the Hijri year whose 1 Muharram starts the cycle;
 * `periodStart`/`periodEnd` are that cycle's boundaries as Gregorian dates
 * (`periodEnd` is exclusive — the instant 1 Muharram of the next Hijri year
 * begins).
 */
export const getCurrentMuharramPeriod = (gregorianDate = new Date()) => {
  // UTC-anchored throughout — a local-time moment() would let the server's
  // own TZ (process.env.TZ, or the host's if unset) shift which Hijri day a
  // date resolves to near midnight, making period boundaries depend on
  // where this process happens to run. Not a hypothetical: this ships on
  // hosts as far as UTC+5, enough to flip a boundary date entirely.
  const asOf = moment.utc(gregorianDate);
  if (!asOf.isValid()) throw new Error(`Invalid date: ${gregorianDate}`);

  const hijriYear = asOf.iYear();
  const periodStart = moment.utc(`${hijriYear}/1/1`, "iYYYY/iM/iD").startOf("day").toDate();
  const periodEnd = moment.utc(`${hijriYear + 1}/1/1`, "iYYYY/iM/iD").startOf("day").toDate();

  return {
    hijriYear,
    financialYear: `AH${hijriYear}`,
    periodStart,
    periodEnd
  };
};

/** True when `gregorianDate` no longer falls within `period` (as returned by getCurrentMuharramPeriod) — the crossing signal the daily rollover check acts on. */
export const hasCrossedMuharramPeriod = (period, gregorianDate = new Date()) => {
  if (!period) return true;
  const time = new Date(gregorianDate).getTime();
  return time < new Date(period.periodStart).getTime() || time >= new Date(period.periodEnd).getTime();
};

/**
 * Single-date Hijri display string (e.g. "14 Muharram 1448H") for document
 * footers (Invoice/Voucher PRD) — distinct from getCurrentMuharramPeriod's
 * cycle-boundary math above, but built on the same UTC-anchored, Umm
 * al-Qura `moment-hijri` authority rather than a second Hijri conversion
 * dependency.
 */
export const formatHijriDate = (gregorianDate = new Date()) => {
  const asOf = moment.utc(gregorianDate);
  if (!asOf.isValid()) return null;
  return `${asOf.format("iD iMMMM iYYYY")}H`;
};
