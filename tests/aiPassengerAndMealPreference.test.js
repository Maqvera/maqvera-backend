import test from "node:test";
import assert from "node:assert/strict";
import AIContextMemory from "../services/ai/AIContextMemory.js";
import { filterOffersByMealPreference } from "../services/ai/AIToolRegistry.js";
import AIGuardrailService from "../services/ai/AIGuardrailService.js";

// Gap 1.3 "AIContextMemory schema is ahead of tool capability" — traced and
// built end-to-end for passenger counts (flight_search -> real Amadeus
// children/infants query params), multi-traveler + nationality
// (propose_flight_booking -> the real POST /api/v1/flight-bookings, which
// already supported an arbitrary-length travelers array), and hotel
// meal-preference (get_hotel_room_offers filtering real returned offers).
// `pricingToken` and flight-side special-assistance/wheelchair/meal-request
// remain honestly unsupported — no tool/endpoint anywhere produces or
// accepts them. All pure-logic tests, no network/DB.

test("AIContextMemory.applyToolExecution: flight_search now captures children/infants into passengers", () => {
  const ctx = AIContextMemory.empty();
  const applied = AIContextMemory.applyToolExecution(ctx, "flight_search", { origin: "KHI", destination: "JED", adults: 2, children: 1, infants: 1 });
  assert.equal(applied, true);
  assert.equal(ctx.passengers.adults, 2);
  assert.equal(ctx.passengers.children, 1);
  assert.equal(ctx.passengers.infants, 1);
});

test("AIContextMemory.applyToolExecution: flight_search with only adults leaves children/infants untouched (no false zero)", () => {
  const ctx = AIContextMemory.empty();
  AIContextMemory.applyToolExecution(ctx, "flight_search", { origin: "KHI", destination: "JED", adults: 1 });
  assert.equal(ctx.passengers.children, null);
  assert.equal(ctx.passengers.infants, null);
});

test("AIContextMemory.applyToolExecution: get_hotel_room_offers now captures mealPreference", () => {
  const ctx = AIContextMemory.empty();
  AIContextMemory.applyToolExecution(ctx, "get_hotel_room_offers", { hotelId: "H1", checkInDate: "2027-01-01", checkOutDate: "2027-01-03", mealPreference: "Half Board" });
  assert.equal(ctx.hotel.mealPreference, "Half Board");
});

test("AIContextMemory.applyToolExecution: propose_flight_booking now captures the first traveler's nationality", () => {
  const ctx = AIContextMemory.empty();
  const args = { offerId: "OFF-1", travelers: [{ firstName: "A", lastName: "B", passportNumber: "P1", nationality: "PK" }, { firstName: "C", lastName: "D", passportNumber: "P2", nationality: "SA" }] };
  AIContextMemory.applyToolExecution(ctx, "propose_flight_booking", args, { approvalRequestId: "APR-1" });
  assert.equal(ctx.passengers.nationality, "PK");
  assert.equal(ctx.booking.flightApprovalRequestId, "APR-1");
});

test("AIContextMemory.applyToolExecution: propose_flight_booking with no traveler nationality leaves it null, never fabricated", () => {
  const ctx = AIContextMemory.empty();
  const args = { offerId: "OFF-1", travelers: [{ firstName: "A", lastName: "B", passportNumber: "P1" }] };
  AIContextMemory.applyToolExecution(ctx, "propose_flight_booking", args, {});
  assert.equal(ctx.passengers.nationality, null);
});

test("filterOffersByMealPreference: case-insensitive substring match against real offer data, never an exact/enum match", () => {
  const offers = [
    { offerId: "1", mealPlan: "Room Only" },
    { offerId: "2", mealPlan: "Breakfast Included" },
    { offerId: "3", mealPlan: "Half Board" },
    { offerId: "4", mealPlan: null }
  ];
  assert.deepEqual(filterOffersByMealPreference(offers, "breakfast").map((o) => o.offerId), ["2"]);
  assert.deepEqual(filterOffersByMealPreference(offers, "BOARD").map((o) => o.offerId), ["3"]);
  assert.equal(filterOffersByMealPreference(offers, "all inclusive").length, 0, "a preference matching nothing must yield an honestly empty result, never a fabricated one");
});

test("filterOffersByMealPreference: no preference returns every offer unchanged", () => {
  const offers = [{ offerId: "1", mealPlan: "Room Only" }];
  assert.equal(filterOffersByMealPreference(offers, null), offers);
  assert.equal(filterOffersByMealPreference(offers, undefined), offers);
});

test("Gap 1.3 regression guard: passportNumber nested inside propose_flight_booking's new travelers array is still masked before persistence", () => {
  const args = { offerId: "OFF-1", travelers: [{ firstName: "A", lastName: "B", passportNumber: "AB1234567", nationality: "PK" }] };
  const masked = AIGuardrailService.maskSensitiveData(args);
  assert.equal(masked.travelers[0].passportNumber, "***MASKED***");
  assert.equal(masked.travelers[0].firstName, "A", "non-sensitive fields must survive masking unchanged");
  assert.equal(masked.offerId, "OFF-1");
});
