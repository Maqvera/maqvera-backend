import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Company-level isolation check for the Package Pricing Engine — same
// convention as tests/bookingIsolation.test.js (direct controller calls
// with a mock res, no supertest). Every master/rate model plus every
// state-changing Package action must reject/never-leak another tenant's
// data via getAccessScope(req)'s { tenantId } scoping.

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

const authFor = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

test("Package Pricing Engine: master/rate lists, cross-tenant reads/updates, and rate resolution are all tenant-isolated", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/PackagePricingController.js");
  const PackagePricingService = (await import("../services/PackagePricingService.js")).default;
  const RoomTypeModel = (await import("../models/RoomTypeModel.js")).default;
  const TransportVehicleModel = (await import("../models/TransportVehicleModel.js")).default;
  const HotelRateModel = (await import("../models/HotelRateModel.js")).default;
  const TransportRateModel = (await import("../models/TransportRateModel.js")).default;
  const FlightRateModel = (await import("../models/FlightRateModel.js")).default;
  const VisaRateModel = (await import("../models/VisaRateModel.js")).default;
  const ServiceRateModel = (await import("../models/ServiceRateModel.js")).default;
  const MarkupRuleModel = (await import("../models/MarkupRuleModel.js")).default;
  const SupplierModel = (await import("../models/SupplierModel.js")).default;
  const CommissionRuleModel = (await import("../models/CommissionRuleModel.js")).default;
  const PackageModel = (await import("../models/PackageModel.js")).default;
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-pkg-iso-a-${suffix}`;
  const tenantB = `test-pkg-iso-b-${suffix}`;

  const cleanupModels = [
    RoomTypeModel, TransportVehicleModel, HotelRateModel, TransportRateModel, FlightRateModel, VisaRateModel,
    ServiceRateModel, MarkupRuleModel, SupplierModel, CommissionRuleModel, PackageModel, HotelCatalogModel
  ];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId: { $in: [tenantA, tenantB] } })));
  });

  // ---- One row per tenant for every master/rate model, seeded directly
  // (bypassing service-layer create validation, same as bookingIsolation's
  // own direct BookingHeaderModel.create) ----
  const hotelA = await HotelCatalogModel.create({ tenantId: tenantA, name: `Hotel-${suffix}`, city: "TestCity" });
  const roomTypeA = await RoomTypeModel.create({ tenantId: tenantA, name: `Double-${suffix}`, defaultOccupancy: 2 });
  await RoomTypeModel.create({ tenantId: tenantB, name: `Double-${suffix}`, defaultOccupancy: 2 });

  const vehicleA = await TransportVehicleModel.create({ tenantId: tenantA, name: `Van-${suffix}`, minCapacity: 1, maxCapacity: 8 });
  await TransportVehicleModel.create({ tenantId: tenantB, name: `Van-${suffix}`, minCapacity: 1, maxCapacity: 8 });

  // Same hotelCatalogId/roomTypeId, cross-tenant, DIFFERENT price — this is
  // the exact fixture that catches an accidentally-unscoped rate query.
  const hotelRateA = await HotelRateModel.create({ tenantId: tenantA, hotelCatalogId: hotelA._id, roomTypeId: roomTypeA._id, currency: "USD", pricePerNight: 100, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" });
  await HotelRateModel.create({ tenantId: tenantB, hotelCatalogId: hotelA._id, roomTypeId: roomTypeA._id, currency: "USD", pricePerNight: 999, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" });

  // Same origin/destination/vehicleId (vehicleA belongs to tenant A; tenant
  // B's row below is a deliberately "leaked reference" fixture), different rate.
  const transportRateA = await TransportRateModel.create({ tenantId: tenantA, origin: "TestOrigin", destination: "TestDestination", vehicleId: vehicleA._id, currency: "USD", rate: 50, direction: "OneWay", status: "Active", source: "Manual" });
  await TransportRateModel.create({ tenantId: tenantB, origin: "TestOrigin", destination: "TestDestination", vehicleId: vehicleA._id, currency: "USD", rate: 999, direction: "OneWay", status: "Active", source: "Manual" });

  const flightRateA = await FlightRateModel.create({ tenantId: tenantA, route: "X-Y", currency: "USD", costPerPerson: 200, direction: "OneWay", status: "Active", source: "Manual" });
  await FlightRateModel.create({ tenantId: tenantB, route: "X-Y", currency: "USD", costPerPerson: 999, direction: "OneWay", status: "Active", source: "Manual" });

  const visaRateA = await VisaRateModel.create({ tenantId: tenantA, country: "TestCountry", visaType: "Tourist", currency: "USD", adultCost: 50, status: "Active", source: "Manual" });
  await VisaRateModel.create({ tenantId: tenantB, country: "TestCountry", visaType: "Tourist", currency: "USD", adultCost: 999, status: "Active", source: "Manual" });

  const serviceRateA = await ServiceRateModel.create({ tenantId: tenantA, name: "Insurance", chargeBasis: "PerPerson", currency: "USD", amount: 10, status: "Active", source: "Manual" });
  await ServiceRateModel.create({ tenantId: tenantB, name: "Insurance", chargeBasis: "PerPerson", currency: "USD", amount: 999, status: "Active", source: "Manual" });

  const markupRuleA = await MarkupRuleModel.create({ tenantId: tenantA, scope: "Hotel", type: "Fixed", value: 10, priceListType: "B2C" });
  await MarkupRuleModel.create({ tenantId: tenantB, scope: "Hotel", type: "Fixed", value: 999, priceListType: "B2C" });

  const supplierA = await SupplierModel.create({ tenantId: tenantA, name: `Supplier-${suffix}`, category: "Hotel" });
  await SupplierModel.create({ tenantId: tenantB, name: `Supplier-${suffix}`, category: "Hotel" });

  await CommissionRuleModel.create({ tenantId: tenantA, scope: "Global", type: "Fixed", value: 5 });
  await CommissionRuleModel.create({ tenantId: tenantB, scope: "Global", type: "Fixed", value: 999 });

  // ---- List isolation: tenant A and tenant B must never see overlapping rows ----
  const listEndpoints = [
    "listRoomTypes", "listTransportVehicles", "listHotelRates", "listTransportRates",
    "listFlightRates", "listVisaRates", "listServiceRates", "listMarkupRules", "listSuppliers", "listCommissionRules"
  ];
  for (const fn of listEndpoints) {
    const resA = makeRes();
    await ctrl[fn]({ auth: authFor(tenantA), query: {} }, resA);
    assert.equal(resA.statusCode, 200, `${fn} (tenant A) status: ${JSON.stringify(resA.body)}`);

    const resB = makeRes();
    await ctrl[fn]({ auth: authFor(tenantB), query: {} }, resB);
    assert.equal(resB.statusCode, 200, `${fn} (tenant B) status: ${JSON.stringify(resB.body)}`);

    const idsA = resA.body.data.items.map((i) => i._id.toString());
    const idsB = resB.body.data.items.map((i) => i._id.toString());
    assert.deepEqual(idsA.filter((id) => idsB.includes(id)), [], `${fn}: tenant A and tenant B lists must never overlap`);
  }

  // No auth context at all -> rejected, never defaulted to "match everything".
  const noAuthRes = makeRes();
  await ctrl.listRoomTypes({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));

  // ---- Cross-tenant PATCH: tenant B must never be able to update tenant A's rate/master rows ----
  const patchCases = [
    { fn: "updateRoomType", param: "roomTypeId", id: roomTypeA._id },
    { fn: "updateTransportVehicle", param: "vehicleId", id: vehicleA._id },
    { fn: "updateHotelRate", param: "rateId", id: hotelRateA._id },
    { fn: "updateTransportRate", param: "rateId", id: transportRateA._id },
    { fn: "updateFlightRate", param: "rateId", id: flightRateA._id },
    { fn: "updateVisaRate", param: "rateId", id: visaRateA._id },
    { fn: "updateServiceRate", param: "rateId", id: serviceRateA._id },
    { fn: "updateMarkupRule", param: "ruleId", id: markupRuleA._id },
    { fn: "updateSupplier", param: "supplierId", id: supplierA._id }
  ];
  for (const { fn, param, id } of patchCases) {
    const res = makeRes();
    await ctrl[fn]({ auth: authFor(tenantB), params: { [param]: id.toString() }, body: {} }, res);
    assert.equal(res.statusCode, 404, `${fn} cross-tenant should 404, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }
  // Same-tenant update still works (proves the 404 above is real isolation, not a broken endpoint).
  const sameTenantPatch = makeRes();
  await ctrl.updateRoomType({ auth: authFor(tenantA), params: { roomTypeId: roomTypeA._id.toString() }, body: { sortOrder: 5 } }, sameTenantPatch);
  assert.equal(sameTenantPatch.statusCode, 200, JSON.stringify(sameTenantPatch.body));

  // ---- Package: create under tenant A, exercise every state-changing action from tenant B ----
  const pkgA = await PackageModel.create({
    tenantId: tenantA, travelStartDate: new Date("2027-06-01"), travelEndDate: new Date("2027-06-05"),
    travelers: { adults: 2, children: 0, infants: 0 },
    segments: [{ city: "TestCity", hotelCatalogId: hotelA._id, checkIn: new Date("2027-06-01"), checkOut: new Date("2027-06-03"), rooms: 1 }],
    transportLegs: [{ origin: "TestOrigin", destination: "TestDestination" }],
    vehicleSelectionRule: "MinimumVehicles", priceListType: "B2C", sellingCurrency: "USD", roundingRule: "None", status: "Draft"
  });
  await PackageModel.create({ tenantId: tenantB, travelStartDate: new Date("2027-06-01"), travelEndDate: new Date("2027-06-05"), travelers: { adults: 1 }, segments: [], vehicleSelectionRule: "MinimumVehicles", priceListType: "B2C", sellingCurrency: "USD", roundingRule: "None", status: "Draft" });

  const listPkgA = makeRes();
  await ctrl.listPackages({ auth: authFor(tenantA), query: {} }, listPkgA);
  assert.equal(listPkgA.statusCode, 200);
  assert.ok(listPkgA.body.data.items.some((p) => p._id.toString() === pkgA._id.toString()));
  const listPkgB = makeRes();
  await ctrl.listPackages({ auth: authFor(tenantB), query: {} }, listPkgB);
  assert.ok(!listPkgB.body.data.items.some((p) => p._id.toString() === pkgA._id.toString()), "tenant B's package list must never include tenant A's package");

  const getCross = makeRes();
  await ctrl.getPackage({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() } }, getCross);
  assert.equal(getCross.statusCode, 404, JSON.stringify(getCross.body));

  const updateCross = makeRes();
  await ctrl.updatePackage({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: { name: "Hijacked" } }, updateCross);
  assert.equal(updateCross.statusCode, 404, JSON.stringify(updateCross.body));

  const dummyRoomTypeId = new mongoose.Types.ObjectId().toString();

  const calcCross = makeRes();
  await ctrl.calculatePackage({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: {} }, calcCross);
  assert.equal(calcCross.statusCode, 404, JSON.stringify(calcCross.body));

  const finalizeCross = makeRes();
  await ctrl.finalizePackage({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: {} }, finalizeCross);
  assert.equal(finalizeCross.statusCode, 404, JSON.stringify(finalizeCross.body));

  const convertCross = makeRes();
  await ctrl.convertPackageToBooking({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: { roomTypeId: dummyRoomTypeId } }, convertCross);
  assert.equal(convertCross.statusCode, 404, JSON.stringify(convertCross.body));

  const flyerCross = makeRes();
  await ctrl.generateFlyer({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: {} }, flyerCross);
  assert.equal(flyerCross.statusCode, 404, JSON.stringify(flyerCross.body));

  const quotationCross = makeRes();
  await ctrl.createQuotation({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: { roomTypeId: dummyRoomTypeId } }, quotationCross);
  assert.equal(quotationCross.statusCode, 404, JSON.stringify(quotationCross.body));

  const whatsappCross = makeRes();
  await ctrl.sendWhatsAppMessage({ auth: authFor(tenantB), params: { packageId: pkgA._id.toString() }, body: {} }, whatsappCross);
  assert.equal(whatsappCross.statusCode, 404, JSON.stringify(whatsappCross.body));

  // ---- Rate resolution regression: tenant A's calculation must use ONLY
  // tenant A's own hotel/transport rates, never the same-hotelCatalogId/
  // same-route row seeded under tenant B above (proves the tenantId filter
  // is actually present in calculatePackage's own HotelRateModel.find /
  // TransportRateModel.find calls, not just at the controller layer). ----
  const calcResult = await PackagePricingService.calculatePackage(pkgA._id, tenantA, "tester");
  assert.equal(calcResult.ready, true, JSON.stringify(calcResult.validationIssues));
  assert.equal(calcResult.roomWisePriceMatrix.length, 1);
  const row = calcResult.roomWisePriceMatrix[0];
  // (100 SAR/night * 2 nights * 1 room) / 2 occupancy = 100 — tenant A's own
  // rate. If tenant B's 999 rate leaked in, this would be 999 instead.
  assert.equal(row.hotelCostPerPerson, 100, "hotel rate resolution leaked a cross-tenant rate");
  // 50 (tenant A's transport rate) / 2 total pax = 25 — same leak check for transport.
  assert.equal(row.transportCostPerPerson, 25, "transport rate resolution leaked a cross-tenant rate");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
