import test from "node:test";
import assert from "node:assert/strict";
import {
  computeNights,
  resolveHotelRate,
  resolveHotelRateAnyStatus,
  classifyRateAvailability,
  detectOverlappingHotelRates,
  computeHotelCostPerPerson,
  selectVehicles,
  computeAgeBand,
  computeVisaCost,
  computeServiceCost,
  computeMarkupAmount,
  computeDiscountPerPerson,
  computeExtraBedCost,
  suggestRoomCombinations,
  applyRounding
} from "../services/PackagePricingService.js";

const config = {
  usableRateStatuses: ["Active"],
  hotelRateBasisPriority: ["ExactDate", "DateRange", "Season", "Weekend", "Weekday", "Standard"],
  ageBands: { infantMaxAge: 1.99, childMaxAge: 11.99 },
  rateStatuses: ["Draft", "Verified", "Active", "OnRequest", "StopSale", "SoldOut", "Expired", "Archived"],
  onRequestLikeStatuses: ["OnRequest", "StopSale", "SoldOut"]
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

test("resolveHotelRateAnyStatus matches an On Request/Stop Sale/Sold Out rate that resolveHotelRate would silently skip", () => {
  const roomTypeId = "rt1";
  const rates = [{ roomTypeId, status: "StopSale", rateBasis: "Standard", pricePerNight: 100 }];
  assert.equal(resolveHotelRate(rates, { roomTypeId, date: "2027-06-15" }, config), null);
  const anyStatus = resolveHotelRateAnyStatus(rates, { roomTypeId, date: "2027-06-15" }, config);
  assert.equal(anyStatus.pricePerNight, 100);
  assert.equal(classifyRateAvailability(anyStatus, config), "StopSale");
});

test("resolveHotelRateAnyStatus never matches a Draft/Expired/Archived rate — those stay genuinely missing", () => {
  const roomTypeId = "rt1";
  for (const status of ["Draft", "Expired", "Archived"]) {
    const rates = [{ roomTypeId, status, rateBasis: "Standard", pricePerNight: 100 }];
    assert.equal(resolveHotelRateAnyStatus(rates, { roomTypeId, date: "2027-06-15" }, config), null, `status ${status} must not resolve`);
  }
});

test("classifyRateAvailability distinguishes usable/on-request-like/missing", () => {
  assert.equal(classifyRateAvailability({ status: "Active" }, config), "usable");
  assert.equal(classifyRateAvailability({ status: "OnRequest" }, config), "OnRequest");
  assert.equal(classifyRateAvailability({ status: "SoldOut" }, config), "SoldOut");
  assert.equal(classifyRateAvailability({ status: "Draft" }, config), "missing");
  assert.equal(classifyRateAvailability(null, config), "missing");
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

test("computeExtraBedCost: PerNight multiplies by nights, PerStay/PerPerson is a flat charge per extra occupant", () => {
  assert.equal(computeExtraBedCost(1, 20, "PerNight", 5), 100);
  assert.equal(computeExtraBedCost(2, 20, "PerNight", 5), 200);
  assert.equal(computeExtraBedCost(1, 50, "PerStay", 5), 50);
  assert.equal(computeExtraBedCost(2, 50, "PerPerson", 5), 100);
});

test("computeExtraBedCost returns 0 when there are no extra occupants or no rate configured", () => {
  assert.equal(computeExtraBedCost(0, 50, "PerStay", 5), 0);
  assert.equal(computeExtraBedCost(2, 0, "PerStay", 5), 0);
  assert.equal(computeExtraBedCost(2, null, "PerStay", 5), 0);
});

test("suggestRoomCombinations reproduces the PRD's own 8-adult example (4 Double, 2 Quad, 1 Quad+2 Double, 2 Triple+1 Double)", () => {
  const types = [
    { roomTypeId: "double", defaultOccupancy: 2 },
    { roomTypeId: "triple", defaultOccupancy: 3 },
    { roomTypeId: "quad", defaultOccupancy: 4 }
  ];
  const results = suggestRoomCombinations(8, types);
  const find = (roomTypeCounts) => results.find((r) => r.combination.length === Object.keys(roomTypeCounts).length && Object.entries(roomTypeCounts).every(([id, count]) => r.combination.some((c) => c.roomTypeId === id && c.count === count)));

  assert.ok(find({ double: 4 }), "4 Double must be suggested");
  assert.ok(find({ quad: 2 }), "2 Quad must be suggested");
  assert.ok(find({ quad: 1, double: 2 }), "1 Quad + 2 Double must be suggested");
  assert.ok(find({ triple: 2, double: 1 }), "2 Triple + 1 Double must be suggested");
  assert.ok(results.every((r) => r.totalCapacity >= 8), "every suggested combination must sleep everyone");
});

test("suggestRoomCombinations returns nothing for zero passengers or no room types", () => {
  assert.deepEqual(suggestRoomCombinations(0, [{ roomTypeId: "double", defaultOccupancy: 2 }]), []);
  assert.deepEqual(suggestRoomCombinations(4, []), []);
});

test("applyRounding snaps to the configured step, and falls back to 2-decimal rounding for None/Custom", () => {
  assert.equal(applyRounding(1234, "Nearest100"), 1200);
  assert.equal(applyRounding(1250, "Nearest100"), 1300);
  assert.equal(applyRounding(1234.567, "None"), 1234.57);
  assert.equal(applyRounding(1234.567, "Custom"), 1234.57);
});
