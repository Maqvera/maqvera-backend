import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHotelServiceDetails, computeNights, effectiveNights } from "../utils/hotelServiceDetails.js";

test("normalizeHotelServiceDetails computes nights server-side from checkIn/checkOut", () => {
  const result = normalizeHotelServiceDetails({
    hotelName: "Swissotel Al Maqam Makkah",
    roomType: "Deluxe Twin",
    adultCount: 2,
    checkIn: "2026-09-01",
    checkOut: "2026-09-05"
  });
  assert.equal(result.nights, 4);
  assert.equal(result.overrideNights, null);
});

test("normalizeHotelServiceDetails rejects missing required fields", () => {
  assert.throws(
    () => normalizeHotelServiceDetails({ hotelName: "Hilton" }),
    /Missing required hotel detail field/
  );
});

test("normalizeHotelServiceDetails rejects checkOut before checkIn", () => {
  assert.throws(
    () => normalizeHotelServiceDetails({
      hotelName: "Hilton", roomType: "Suite", adultCount: 1,
      checkIn: "2026-09-05", checkOut: "2026-09-01"
    }),
    /checkOut must be after checkIn/
  );
});

test("normalizeHotelServiceDetails never lets overrideNights silently replace computed nights", () => {
  const result = normalizeHotelServiceDetails({
    hotelName: "Hilton", roomType: "Suite", adultCount: 1,
    checkIn: "2026-09-01", checkOut: "2026-09-03",
    overrideNights: 5, overrideNightsReason: "Extra night comped by supplier"
  }, { performedBy: "user-123" });

  assert.equal(result.nights, 2, "computed nights must remain the true value");
  assert.equal(result.overrideNights, 5);
  assert.equal(result.overrideNightsReason, "Extra night comped by supplier");
  assert.equal(result.overriddenBy, "user-123");
  assert.ok(result.overriddenAt instanceof Date);
  assert.equal(effectiveNights(result), 5, "effectiveNights prefers the audited override");
});

test("normalizeHotelServiceDetails requires a reason when overrideNights is supplied", () => {
  assert.throws(
    () => normalizeHotelServiceDetails({
      hotelName: "Hilton", roomType: "Suite", adultCount: 1,
      checkIn: "2026-09-01", checkOut: "2026-09-03", overrideNights: 5
    }),
    /overrideNightsReason is required/
  );
});

test("normalizeHotelServiceDetails merges partial updates against existing details", () => {
  const existing = normalizeHotelServiceDetails({
    hotelName: "Hilton", roomType: "Suite", adultCount: 2,
    checkIn: "2026-09-01", checkOut: "2026-09-04", ratePerNight: 100
  });

  const updated = normalizeHotelServiceDetails({ ratePerNight: 150 }, { existing });
  assert.equal(updated.hotelName, "Hilton");
  assert.equal(updated.ratePerNight, 150);
  assert.equal(updated.nights, 3);
});

test("computeNights rounds to whole nights", () => {
  assert.equal(computeNights("2026-01-01", "2026-01-04"), 3);
});

test("effectiveNights falls back to computed nights when no override present", () => {
  const result = normalizeHotelServiceDetails({
    hotelName: "Hilton", roomType: "Suite", adultCount: 1,
    checkIn: "2026-09-01", checkOut: "2026-09-02"
  });
  assert.equal(effectiveNights(result), 1);
});
