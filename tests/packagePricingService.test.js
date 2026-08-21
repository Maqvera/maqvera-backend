import test from "node:test";
import assert from "node:assert/strict";
import {
  computeNights,
  resolveHotelRate,
  detectOverlappingHotelRates,
  computeHotelCostPerPerson,
  selectVehicles,
  computeAgeBand,
  computeVisaCost,
  computeServiceCost,
  computeMarkupAmount,
  computeDiscountPerPerson,
  applyRounding
} from "../services/PackagePricingService.js";

const config = {
  usableRateStatuses: ["Active"],
  hotelRateBasisPriority: ["ExactDate", "DateRange", "Season", "Weekend", "Weekday", "Standard"],
  ageBands: { infantMaxAge: 1.99, childMaxAge: 11.99 }
};

test("computeNights returns the whole-day gap between checkIn and checkOut, never negative", () => {
  assert.equal(computeNights("2027-01-01", "2027-01-04"), 3);
  assert.equal(computeNights("2027-01-04", "2027-01-04"), 0);
  assert.equal(computeNights("2027-01-05", "2027-01-04"), 0);
});

test("resolveHotelRate follows ExactDate > DateRange > Season > Weekend/Weekday > Standard priority", () => {
  const roomTypeId = "rt1";
  const rates = [
    { roomTypeId, status: "Active", rateBasis: "Standard", validFrom: null, validTo: null, pricePerNight: 100 },
    { roomTypeId, status: "Active", rateBasis: "DateRange", validFrom: "2027-06-01", validTo: "2027-06-30", pricePerNight: 150 },
    { roomTypeId, status: "Active", rateBasis: "ExactDate", date: "2027-06-15", pricePerNight: 300 }
  ];
  assert.equal(resolveHotelRate(rates, { roomTypeId, date: "2027-06-15" }, config).pricePerNight, 300);
  assert.equal(resolveHotelRate(rates, { roomTypeId, date: "2027-06-16" }, config).pricePerNight, 150);
  assert.equal(resolveHotelRate(rates, { roomTypeId, date: "2027-07-01" }, config).pricePerNight, 100);
});

test("resolveHotelRate ignores rates for a different room type or a non-Active status", () => {
  const rates = [
    { roomTypeId: "rt1", status: "Active", rateBasis: "Standard", pricePerNight: 100 },
    { roomTypeId: "rt2", status: "Active", rateBasis: "ExactDate", date: "2027-06-15", pricePerNight: 999 },
    { roomTypeId: "rt1", status: "StopSale", rateBasis: "ExactDate", date: "2027-06-15", pricePerNight: 500 }
  ];
  const resolved = resolveHotelRate(rates, { roomTypeId: "rt1", date: "2027-06-15" }, config);
  assert.equal(resolved.pricePerNight, 100);
});

test("resolveHotelRate returns null (never a silent zero) when no usable rate covers the date", () => {
  assert.equal(resolveHotelRate([], { roomTypeId: "rt1", date: "2027-06-15" }, config), null);
});

test("resolveHotelRate matches Weekend rates by day-of-week within the validity window", () => {
  const roomTypeId = "rt1";
  const rates = [
    { roomTypeId, status: "Active", rateBasis: "Standard", pricePerNight: 100 },
    { roomTypeId, status: "Active", rateBasis: "Weekend", daysOfWeek: [5, 6], validFrom: "2027-06-01", validTo: "2027-06-30", pricePerNight: 200 }
  ];
  // 2027-06-04 is a Friday (day 5)
  assert.equal(resolveHotelRate(rates, { roomTypeId, date: "2027-06-04" }, config).pricePerNight, 200);
  // 2027-06-07 is a Monday (day 1) -> falls back to Standard
  assert.equal(resolveHotelRate(rates, { roomTypeId, date: "2027-06-07" }, config).pricePerNight, 100);
});

test("detectOverlappingHotelRates flags overlapping DateRange/Season windows for the same hotel+roomType, never Standard/ExactDate", () => {
  const rates = [
    { _id: "a", hotelCatalogId: "h1", roomTypeId: "rt1", rateBasis: "DateRange", validFrom: "2027-06-01", validTo: "2027-06-15" },
    { _id: "b", hotelCatalogId: "h1", roomTypeId: "rt1", rateBasis: "DateRange", validFrom: "2027-06-10", validTo: "2027-06-20" },
    { _id: "c", hotelCatalogId: "h1", roomTypeId: "rt1", rateBasis: "Standard" }
  ];
  const overlaps = detectOverlappingHotelRates(rates);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0].rateIds, ["a", "b"]);
});

test("computeHotelCostPerPerson divides pricePerNight x nights x rooms across occupancy", () => {
  assert.equal(computeHotelCostPerPerson(400, 3, 1, 2), 600); // (400*3*1)/2
  assert.equal(computeHotelCostPerPerson(400, 3, 2, 4), 600); // (400*3*2)/4
  assert.equal(computeHotelCostPerPerson(400, 3, 1, 0), 0);
});

test("selectVehicles picks the largest-capacity active vehicle for MinimumVehicles", () => {
  const vehicles = [
    { _id: "sedan", active: true, maxCapacity: 4 },
    { _id: "coaster", active: true, maxCapacity: 20 },
    { _id: "van", active: false, maxCapacity: 12 }
  ];
  const result = selectVehicles(vehicles, 25, "MinimumVehicles");
  assert.equal(result.vehicleId, "coaster");
  assert.equal(result.vehicleCount, 2); // ceil(25/20)
});

test("selectVehicles picks the cheapest total-cost combination when ratesByVehicleId is supplied", () => {
  const vehicles = [
    { _id: "sedan", active: true, maxCapacity: 4 },
    { _id: "coaster", active: true, maxCapacity: 20 }
  ];
  // 5 passengers: 2 sedans (2*50=100) vs 1 coaster (1*300=300) -> sedan wins
  const result = selectVehicles(vehicles, 5, "Cheapest", { ratesByVehicleId: { sedan: 50, coaster: 300 } });
  assert.equal(result.vehicleId, "sedan");
  assert.equal(result.vehicleCount, 2);
});

test("selectVehicles honors an explicit PreferredVehicle when it exists and is active", () => {
  const vehicles = [{ _id: "van", active: true, maxCapacity: 10 }, { _id: "coaster", active: true, maxCapacity: 20 }];
  const result = selectVehicles(vehicles, 8, "PreferredVehicle", { preferredVehicleId: "van" });
  assert.equal(result.vehicleId, "van");
  assert.equal(result.vehicleCount, 1);
});

test("selectVehicles returns no selection when there are no active vehicles or no passengers", () => {
  assert.equal(selectVehicles([], 5, "MinimumVehicles").vehicleId, null);
  assert.equal(selectVehicles([{ _id: "v", active: true, maxCapacity: 10 }], 0, "MinimumVehicles").vehicleId, null);
});

test("computeAgeBand classifies by the configured infant/child/adult cutoffs", () => {
  assert.equal(computeAgeBand(1, config.ageBands), "infant");
  assert.equal(computeAgeBand(5, config.ageBands), "child");
  assert.equal(computeAgeBand(12, config.ageBands), "adult");
  assert.equal(computeAgeBand(null, config.ageBands), "adult");
});

test("computeVisaCost falls back child cost to adult cost and infant cost to zero when unset", () => {
  assert.equal(computeVisaCost({ adults: 2, children: 1, infants: 1 }, { adultCost: 100, childCost: null, infantCost: null }), 300); // 2*100 + 1*100 + 1*0
  assert.equal(computeVisaCost({ adults: 2, children: 1, infants: 1 }, { adultCost: 100, childCost: 50, infantCost: 10 }), 260);
});

test("computeServiceCost dispatches per chargeBasis", () => {
  assert.equal(computeServiceCost({ chargeBasis: "PerPerson", amount: 20 }, { quantity: 1 }), 20);
  assert.equal(computeServiceCost({ chargeBasis: "PerRoom", amount: 40 }, { occupancy: 2, quantity: 1 }), 20);
  assert.equal(computeServiceCost({ chargeBasis: "PerNight", amount: 10 }, { nights: 5, quantity: 1 }), 50);
  assert.equal(computeServiceCost({ chargeBasis: "PerVehicle", amount: 100 }, { vehicleCount: 2, totalPax: 10, quantity: 1 }), 20);
  assert.equal(computeServiceCost({ chargeBasis: "PerGroup", amount: 100 }, { totalPax: 10, quantity: 1 }), 10);
  assert.equal(computeServiceCost({ chargeBasis: "Percentage", amount: 10 }, { runningSubtotal: 1000 }), 100);
  assert.equal(computeServiceCost({ chargeBasis: "Unknown", amount: 10 }, {}), 0);
});

test("computeMarkupAmount computes Fixed as a flat add and Percentage as a share of the base", () => {
  assert.equal(computeMarkupAmount(1000, "Fixed", 50), 50);
  assert.equal(computeMarkupAmount(1000, "Percentage", 10), 100);
  assert.equal(computeMarkupAmount(1000, "Unknown", 10), 0);
});

test("computeDiscountPerPerson: Percentage is always a share of finalPricePerPerson regardless of scope", () => {
  assert.equal(computeDiscountPerPerson({ type: "Percentage", value: 10, scope: "PerRoom" }, { finalPricePerPerson: 1000 }), 100);
  assert.equal(computeDiscountPerPerson({ type: "Percentage", value: 10, scope: "TotalPackage" }, { finalPricePerPerson: 1000 }), 100);
});

test("computeDiscountPerPerson: Fixed splits by scope (PerPerson flat, PerRoom by occupancy, TotalPackage by totalPax)", () => {
  assert.equal(computeDiscountPerPerson({ type: "Fixed", value: 1000, scope: "PerPerson" }, { occupancy: 2, totalPax: 4 }), 1000);
  assert.equal(computeDiscountPerPerson({ type: "Fixed", value: 1000, scope: "PerRoom" }, { occupancy: 2, totalPax: 4 }), 500);
  assert.equal(computeDiscountPerPerson({ type: "Fixed", value: 1000, scope: "TotalPackage" }, { occupancy: 2, totalPax: 4 }), 250);
});

test("computeDiscountPerPerson returns 0 when no discount is configured", () => {
  assert.equal(computeDiscountPerPerson(null, { finalPricePerPerson: 1000 }), 0);
  assert.equal(computeDiscountPerPerson({ type: null }, { finalPricePerPerson: 1000 }), 0);
});

test("applyRounding snaps to the configured step, and falls back to 2-decimal rounding for None/Custom", () => {
  assert.equal(applyRounding(1234, "Nearest100"), 1200);
  assert.equal(applyRounding(1250, "Nearest100"), 1300);
  assert.equal(applyRounding(1234.567, "None"), 1234.57);
  assert.equal(applyRounding(1234.567, "Custom"), 1234.57);
});
