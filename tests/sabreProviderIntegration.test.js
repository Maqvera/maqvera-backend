import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Gap-audit "Gap A" — Sabre GDS wiring. Confirmed by reading the code
// (not assumed) that Sabre is ALREADY reachable through the existing
// multi-provider controllers (controllers/FlightSearchController.js,
// controllers/HotelDistributionController.js) via a `provider`/
// `preferredProvider` field that already defaults to "Amadeus" but is
// fully overridable — GdsIntegrationService already dispatches to
// SabreAdapter correctly. This test is the missing piece: real proof that
// the whole chain (search -> fare rules -> hotel search -> hotel booking
// -> hotel cancellation) genuinely resolves to Sabre end to end, not just
// that the code compiles. controllers/ExternalFlightController.js (the
// EXT-002 spec-compliance contract) is deliberately excluded — its own
// doc comment says "Amadeus only (no Sabre fallback)" on purpose, a
// separate concern from this generic multi-provider surface.

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

const futureDate = (daysFromNow) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split("T")[0];
};

test("Sabre provider wiring: flight search, fare rules, hotel search, hotel booking, hotel cancellation all genuinely resolve to Sabre end-to-end", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const flightSearchCtrl = await import("../controllers/FlightSearchController.js");
  const hotelCtrl = await import("../controllers/HotelDistributionController.js");
  const HotelBookingModel = (await import("../models/HotelBookingModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-sabre-${suffix}`;

  t.after(async () => {
    await HotelBookingModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  // ---- Flight search via Sabre ----
  const searchRes = makeRes();
  await flightSearchCtrl.SearchFlights({
    auth: authAdmin(tenantId),
    body: { origin: "KHI", destination: "JED", departureDate: futureDate(30), adults: 1, currency: "USD", preferredProvider: "Sabre" }
  }, searchRes);
  assert.equal(searchRes.statusCode, 200, JSON.stringify(searchRes.body));
  assert.equal(searchRes.body.data.provider, "Sabre", "the search response must report the provider that actually served it");
  assert.ok(searchRes.body.data.results.length > 0);
  const flightOffer = searchRes.body.data.results[0];
  assert.match(flightOffer.offerId, /^OFF-SABRE-/, "a Sabre-served offer must carry Sabre's own offerId shape, not Amadeus's");

  // ---- Fare rules for that Sabre offer ----
  const fareRulesRes = makeRes();
  await flightSearchCtrl.GetFareRules({ auth: authAdmin(tenantId), body: { offerId: flightOffer.offerId, provider: "Sabre", currency: "USD" } }, fareRulesRes);
  assert.equal(fareRulesRes.statusCode, 200, JSON.stringify(fareRulesRes.body));
  assert.equal(fareRulesRes.body.data.provider, "Sabre");

  // ---- Hotel search via Sabre ----
  const hotelSearchRes = makeRes();
  await hotelCtrl.SearchHotels({
    auth: { tenantId, id: "tester", userId: "tester", permissions: ["hotel.search", "hotel.book"] },
    body: { city: "Makkah", checkIn: futureDate(30), checkOut: futureDate(33), rooms: 1, adults: 2, currency: "USD", provider: "Sabre" }
  }, hotelSearchRes);
  assert.equal(hotelSearchRes.statusCode, 200, JSON.stringify(hotelSearchRes.body));
  assert.equal(hotelSearchRes.body.data.provider, "Sabre");
  assert.ok(hotelSearchRes.body.data.results.length > 0);
  const hotelOffer = hotelSearchRes.body.data.results[0];
  assert.match(hotelOffer.offerId, /^HOTEL-SABRE-/, "a Sabre-served hotel offer must carry Sabre's own offerId shape");

  // ---- Hotel booking — provider is resolved from the cached Sabre search entry, never re-specified ----
  const bookRes = makeRes();
  await hotelCtrl.CreateHotelBooking({
    auth: { tenantId, id: "tester", userId: "tester", permissions: ["hotel.book"] },
    body: { offerId: hotelOffer.offerId, checkIn: futureDate(30), checkOut: futureDate(33), guests: [{ firstName: "Test", lastName: "Guest" }] }
  }, bookRes);
  assert.equal(bookRes.statusCode, 201, JSON.stringify(bookRes.body));
  assert.equal(bookRes.body.data.provider, "Sabre", "a booking created from a Sabre-sourced offer must itself be attributed to Sabre, resolved from the search cache");
  assert.match(bookRes.body.data.reservationNumber, /^SABRE-HB-/);
  const hotelBookingId = bookRes.body.data.hotelBookingId.toString();

  const storedBooking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId }).lean();
  assert.equal(storedBooking.provider, "Sabre");

  // ---- Cancellation — provider resolved from the stored booking, never re-specified ----
  const cancelRes = makeRes();
  await hotelCtrl.CancelHotelBooking({
    auth: { tenantId, id: "tester", userId: "tester", permissions: ["hotel.book"] },
    params: { hotelBookingId },
    body: { reason: "Sabre wiring test cleanup" }
  }, cancelRes);
  assert.equal(cancelRes.statusCode, 200, JSON.stringify(cancelRes.body));

  const cancelledBooking = await HotelBookingModel.findOne({ _id: hotelBookingId, tenantId }).lean();
  assert.equal(cancelledBooking.status, "Cancelled");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
