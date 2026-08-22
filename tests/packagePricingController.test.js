import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Controller/HTTP-level coverage for the Package Pricing Engine — same
// direct-controller-call convention as tests/bookingIsolation.test.js (no
// supertest). tests/packagePricingService.test.js already covers the pure
// calculation helpers in isolation; this file exercises the real Express
// controller functions end to end against a live MongoDB.

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
const authNoCost = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: ["package.pricing.read", "package.pricing.manage", "package.pricing.calculate", "package.pricing.finalize"] });
const authWithCost = (tenantId) => ({ tenantId, id: "manager", userId: "manager", permissions: ["package.pricing.read", "package.pricing.cost.read"] });

const COST_FIELDS = ["hotelCostPerPerson", "transportCostPerPerson", "flightCostPerPerson", "visaCostPerPerson", "servicesCostPerPerson", "subtotalPerPerson", "markupAmount", "commissionPerPerson"];

test("Package Pricing Engine controller: calculate/finalize happy path, room-type intersection, permission gating, validation issues, manual override audit trail, and versioning", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/PackagePricingController.js");
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;
  const RoomTypeModel = (await import("../models/RoomTypeModel.js")).default;
  const TransportVehicleModel = (await import("../models/TransportVehicleModel.js")).default;
  const HotelRateModel = (await import("../models/HotelRateModel.js")).default;
  const TransportRateModel = (await import("../models/TransportRateModel.js")).default;
  const PackageModel = (await import("../models/PackageModel.js")).default;
  const RateSnapshotModel = (await import("../models/RateSnapshotModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-pkg-ctrl-${suffix}`;

  const cleanupModels = [HotelCatalogModel, RoomTypeModel, TransportVehicleModel, HotelRateModel, TransportRateModel, PackageModel, RateSnapshotModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
  });

  // ---- Fixtures: two hotel segments, one room type common to both (Double), one only on the first hotel (Triple) ----
  const hotelX = await HotelCatalogModel.create({ tenantId, name: `HotelX-${suffix}`, city: "CityX" });
  const hotelY = await HotelCatalogModel.create({ tenantId, name: `HotelY-${suffix}`, city: "CityY" });

  const doubleRoomRes = makeRes();
  await ctrl.createRoomType({ auth: authAdmin(tenantId), body: { name: `Double-${suffix}`, defaultOccupancy: 2 } }, doubleRoomRes);
  assert.equal(doubleRoomRes.statusCode, 201, JSON.stringify(doubleRoomRes.body));
  const doubleRoomTypeId = doubleRoomRes.body.data._id.toString();

  const tripleRoomRes = makeRes();
  await ctrl.createRoomType({ auth: authAdmin(tenantId), body: { name: `Triple-${suffix}`, defaultOccupancy: 3 } }, tripleRoomRes);
  const tripleRoomTypeId = tripleRoomRes.body.data._id.toString();

  // Double is priced on BOTH hotels; Triple only on hotelX -> must not appear in the final matrix.
  const hotelXDoubleRes = makeRes();
  await ctrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: hotelX._id.toString(), roomTypeId: doubleRoomTypeId, currency: "USD", pricePerNight: 100, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" } }, hotelXDoubleRes);
  assert.equal(hotelXDoubleRes.statusCode, 201, JSON.stringify(hotelXDoubleRes.body));
  const hotelXDoubleRateId = hotelXDoubleRes.body.data._id.toString();

  const hotelXTripleRes = makeRes();
  await ctrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: hotelX._id.toString(), roomTypeId: tripleRoomTypeId, currency: "USD", pricePerNight: 150, occupancy: 3, rateBasis: "Standard", status: "Active", source: "Manual" } }, hotelXTripleRes);
  assert.equal(hotelXTripleRes.statusCode, 201, JSON.stringify(hotelXTripleRes.body));

  const hotelYDoubleRes = makeRes();
  await ctrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: hotelY._id.toString(), roomTypeId: doubleRoomTypeId, currency: "USD", pricePerNight: 80, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" } }, hotelYDoubleRes);
  assert.equal(hotelYDoubleRes.statusCode, 201, JSON.stringify(hotelYDoubleRes.body));
  // (No Triple rate created for hotelY — deliberate.)

  const vehicleRes = makeRes();
  await ctrl.createTransportVehicle({ auth: authAdmin(tenantId), body: { name: `Van-${suffix}`, minCapacity: 1, maxCapacity: 8 } }, vehicleRes);
  const vehicleId = vehicleRes.body.data._id.toString();

  const transportRateRes = makeRes();
  await ctrl.createTransportRate({ auth: authAdmin(tenantId), body: { origin: "CityX", destination: "CityY", vehicleId, currency: "USD", rate: 40, direction: "OneWay", status: "Active", source: "Manual" } }, transportRateRes);
  assert.equal(transportRateRes.statusCode, 201, JSON.stringify(transportRateRes.body));

  // ---- Create the package: 2 generic segments (proves Umrah-style itineraries are just N segments, not hardcoded fields) ----
  const createPkgRes = makeRes();
  await ctrl.createPackage({
    auth: authAdmin(tenantId),
    body: {
      name: `Test Package ${suffix}`,
      travelStartDate: "2027-07-01", travelEndDate: "2027-07-05",
      travelers: { adults: 2 },
      segments: [
        { city: "CityX", hotelCatalogId: hotelX._id.toString(), checkIn: "2027-07-01", checkOut: "2027-07-03", rooms: 1 },
        { city: "CityY", hotelCatalogId: hotelY._id.toString(), checkIn: "2027-07-03", checkOut: "2027-07-05", rooms: 1 }
      ],
      transportLegs: [{ origin: "CityX", destination: "CityY" }],
      sellingCurrency: "USD"
    }
  }, createPkgRes);
  assert.equal(createPkgRes.statusCode, 201, JSON.stringify(createPkgRes.body));
  const packageId = createPkgRes.body.data._id.toString();

  // ---- Calculate: happy path ----
  const calcRes = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId }, body: {} }, calcRes);
  assert.equal(calcRes.statusCode, 200, JSON.stringify(calcRes.body));
  assert.equal(calcRes.body.data.ready, true, JSON.stringify(calcRes.body.data.validationIssues));

  const matrix = calcRes.body.data.roomWisePriceMatrix;
  assert.equal(matrix.length, 1, "only Double (common to both hotels) should appear in the matrix");
  const doubleRow = matrix.find((r) => r.roomTypeId.toString() === doubleRoomTypeId);
  assert.ok(doubleRow, "Double row must be present");
  assert.ok(!matrix.some((r) => r.roomTypeId.toString() === tripleRoomTypeId), "Triple must NOT appear — hotelY has no rate for it");

  // hotelCost = (100*2*1)/2 [hotelX] + (80*2*1)/2 [hotelY] = 180; transport = 40/2 = 20; no markup/discount -> final 200.
  assert.equal(doubleRow.hotelCostPerPerson, 180);
  assert.equal(doubleRow.transportCostPerPerson, 20);
  assert.equal(doubleRow.finalPricePerPerson, 200);
  assert.equal(doubleRow.roomTotal, 400);

  const snapshotAfterCalculate = await RateSnapshotModel.findOne({ tenantId, packageId, snapshotType: "Calculate" }).sort({ createdAt: -1 }).lean();
  assert.ok(snapshotAfterCalculate, "a Calculate-type RateSnapshot must be written");

  // ---- Permission gate: cost fields stripped without package.pricing.cost.read ----
  const getNoCost = makeRes();
  await ctrl.getPackage({ auth: authNoCost(tenantId), params: { packageId } }, getNoCost);
  assert.equal(getNoCost.statusCode, 200);
  const rowNoCost = getNoCost.body.data.roomWisePriceMatrix[0];
  for (const field of COST_FIELDS) assert.equal(rowNoCost[field], undefined, `${field} must be stripped without package.pricing.cost.read`);
  assert.equal(rowNoCost.finalPricePerPerson, 200, "customer-facing price must still be present");

  const getWithCost = makeRes();
  await ctrl.getPackage({ auth: authWithCost(tenantId), params: { packageId } }, getWithCost);
  assert.equal(getWithCost.statusCode, 200);
  const rowWithCost = getWithCost.body.data.roomWisePriceMatrix[0];
  assert.equal(rowWithCost.hotelCostPerPerson, 180, "cost fields must be present with package.pricing.cost.read");

  // ---- Manual override + audit trail: PATCH the hotelX Double rate (while the package is still Draft/unlocked), confirm the audit row, confirm recalculation picks it up ----
  const overrideRes = makeRes();
  await ctrl.updateHotelRate({ auth: authAdmin(tenantId), params: { rateId: hotelXDoubleRateId }, body: { pricePerNight: 120, reason: "Supplier rate correction" } }, overrideRes);
  assert.equal(overrideRes.statusCode, 200, JSON.stringify(overrideRes.body));

  const auditRow = await AuditLogModel.findOne({ tenantId, resource: "HotelRate", resourceId: hotelXDoubleRateId }).sort({ createdAt: -1 }).lean();
  assert.ok(auditRow, "an AuditLogModel row must be written for the override");
  const priceChange = auditRow.details.changes.find((c) => c.field === "pricePerNight");
  assert.ok(priceChange, JSON.stringify(auditRow.details));
  assert.equal(priceChange.oldValue, 100);
  assert.equal(priceChange.newValue, 120);
  assert.equal(auditRow.details.reason, "Supplier rate correction");
  assert.equal(auditRow.userId, "tester");

  // The package isn't locked yet, so a plain recalculate (no `recalculate` flag needed) picks up the new rate.
  const recalcAfterOverride = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId }, body: {} }, recalcAfterOverride);
  assert.equal(recalcAfterOverride.statusCode, 200, JSON.stringify(recalcAfterOverride.body));
  const recalcRow = recalcAfterOverride.body.data.roomWisePriceMatrix.find((r) => r.roomTypeId.toString() === doubleRoomTypeId);
  // hotelCost now (120*2*1)/2 + (80*2*1)/2 = 200 (was 180).
  assert.equal(recalcRow.hotelCostPerPerson, 200, "recalculation must reflect the overridden rate");

  // ---- Finalize (locks the package, reflecting the overridden 200 hotelCost) ----
  const finalizeRes = makeRes();
  await ctrl.finalizePackage({ auth: authAdmin(tenantId), params: { packageId }, body: {} }, finalizeRes);
  assert.equal(finalizeRes.statusCode, 200, JSON.stringify(finalizeRes.body));
  assert.equal(finalizeRes.body.data.locked, true);
  assert.equal(finalizeRes.body.data.status, "Quoted");

  const snapshotAfterFinalize = await RateSnapshotModel.findOne({ tenantId, packageId, snapshotType: "Finalize" }).sort({ createdAt: -1 }).lean();
  assert.ok(snapshotAfterFinalize, "a Finalize-type RateSnapshot must be written");

  // ---- Validation engine: a package with no rate for its hotel must report ready:false with issues, never a 500 ----
  const emptyHotel = await HotelCatalogModel.create({ tenantId, name: `EmptyHotel-${suffix}`, city: "CityZ" });
  const createBadPkgRes = makeRes();
  await ctrl.createPackage({
    auth: authAdmin(tenantId),
    body: {
      travelStartDate: "2027-08-01", travelEndDate: "2027-08-03", travelers: { adults: 1 },
      segments: [{ city: "CityZ", hotelCatalogId: emptyHotel._id.toString(), checkIn: "2027-08-01", checkOut: "2027-08-03", rooms: 1 }],
      sellingCurrency: "USD"
    }
  }, createBadPkgRes);
  const badPackageId = createBadPkgRes.body.data._id.toString();

  const badCalcRes = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId: badPackageId }, body: {} }, badCalcRes);
  assert.equal(badCalcRes.statusCode, 200, "a missing-rate package must never 500");
  assert.equal(badCalcRes.body.data.ready, false);
  assert.ok(badCalcRes.body.data.validationIssues.length > 0);
  assert.ok(badCalcRes.body.data.validationIssues.some((i) => i.code === "NO_HOTEL_RATE" || i.code === "NO_COMMON_ROOM_TYPE"));

  // A hotel rate priced in a currency with no configured exchange rate must surface NO_EXCHANGE_RATE, not throw.
  const noFxRoomRes = makeRes();
  await ctrl.createRoomType({ auth: authAdmin(tenantId), body: { name: `Single-${suffix}`, defaultOccupancy: 1 } }, noFxRoomRes);
  const noFxRoomTypeId = noFxRoomRes.body.data._id.toString();
  await ctrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: emptyHotel._id.toString(), roomTypeId: noFxRoomTypeId, currency: "AED", pricePerNight: 50, occupancy: 1, rateBasis: "Standard", status: "Active", source: "Manual" } }, makeRes());

  const fxCalcRes = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId: badPackageId }, body: {} }, fxCalcRes);
  assert.equal(fxCalcRes.statusCode, 200, "a missing-exchange-rate package must never 500");
  assert.equal(fxCalcRes.body.data.ready, false);
  assert.ok(fxCalcRes.body.data.validationIssues.some((i) => i.code === "NO_EXCHANGE_RATE"), JSON.stringify(fxCalcRes.body.data.validationIssues));

  // ---- Versioning: recalculating a locked package must never mutate it in place ----
  const preVersionMatrix = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
  assert.equal(preVersionMatrix.locked, true);
  assert.equal(preVersionMatrix.version, 1);

  const recalcLockedRes = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId }, body: { recalculate: true } }, recalcLockedRes);
  assert.equal(recalcLockedRes.statusCode, 200, JSON.stringify(recalcLockedRes.body));
  assert.equal(recalcLockedRes.body.data.newVersionOf, packageId, "recalculating a locked package must report which package it superseded");

  const newVersionId = recalcLockedRes.body.data._id.toString();
  assert.notEqual(newVersionId, packageId, "a NEW package document must be created, never the same id");

  const newVersionDoc = await PackageModel.findOne({ _id: newVersionId, tenantId }).lean();
  assert.equal(newVersionDoc.version, 2);
  assert.equal(newVersionDoc.previousVersionId.toString(), packageId);
  assert.equal(newVersionDoc.rootPackageId.toString(), packageId);

  const originalAfterRecalc = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
  assert.equal(originalAfterRecalc.supersededBy.toString(), newVersionId);
  assert.equal(originalAfterRecalc.locked, true, "the original finalized package must remain untouched/still locked");
  assert.equal(originalAfterRecalc.version, 1, "the original package's own version number must never change");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
