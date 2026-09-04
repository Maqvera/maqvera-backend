import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment-hijri";

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

test("Package Pricing Engine controller: quotation create -> send lifecycle, permission gating, missing-recipient validation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/PackagePricingController.js");
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;
  const RoomTypeModel = (await import("../models/RoomTypeModel.js")).default;
  const HotelRateModel = (await import("../models/HotelRateModel.js")).default;
  const PackageModel = (await import("../models/PackageModel.js")).default;
  const QuotationModel = (await import("../models/QuotationModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingServiceModel = (await import("../models/BookingServiceModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;
  const EmailPlatformService = (await import("../services/EmailPlatformService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-pkg-quote-${suffix}`;

  const cleanupModels = [HotelCatalogModel, RoomTypeModel, HotelRateModel, PackageModel, QuotationModel, CustomerModel, BookingHeaderModel, BookingServiceModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
    await NumberingSchemeModel.deleteMany({ tenantId });
  });

  // Stub the outbound send — this test exercises PackagePricingService.sendQuotation's
  // own orchestration (recipient resolution, status transition, audit log), never a
  // real SMTP connection against the live credentials configured in .env.
  const originalSendEmail = EmailPlatformService.sendEmail;
  t.after(() => { EmailPlatformService.sendEmail = originalSendEmail; });
  EmailPlatformService.sendEmail = async ({ to }) => ({ trackingId: "STUB-EML", status: "Delivered", recipients: [to] });

  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Quotation", prefix: "QUO", isDefault: true }, "tester");
  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Booking", prefix: "BK", isDefault: true }, "tester");

  const hotel = await HotelCatalogModel.create({ tenantId, name: `Hotel-${suffix}`, city: "CityQ" });
  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "Quo", lastName: "Tay", email: `quo.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });

  const roomRes = makeRes();
  await ctrl.createRoomType({ auth: authAdmin(tenantId), body: { name: `Room-${suffix}`, defaultOccupancy: 2 } }, roomRes);
  const roomTypeId = roomRes.body.data._id.toString();

  await ctrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: hotel._id.toString(), roomTypeId, currency: "USD", pricePerNight: 100, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" } }, makeRes());

  // customerId deliberately omitted here — the "send: missing recipient"
  // assertion below needs a quotation with no resolvable customer email.
  // The customer is attached directly to the package later, right before
  // the convert-to-booking assertions, so it never affects the earlier
  // quotation snapshot/send behavior.
  const createPkgRes = makeRes();
  await ctrl.createPackage({
    auth: authAdmin(tenantId),
    body: {
      name: `Quote Package ${suffix}`,
      travelStartDate: "2027-09-01", travelEndDate: "2027-09-03",
      travelers: { adults: 2 },
      segments: [{ city: "CityQ", hotelCatalogId: hotel._id.toString(), checkIn: "2027-09-01", checkOut: "2027-09-03", rooms: 1 }],
      sellingCurrency: "USD"
    }
  }, createPkgRes);
  const packageId = createPkgRes.body.data._id.toString();

  const calcRes = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId }, body: {} }, calcRes);
  assert.equal(calcRes.body.data.ready, true, JSON.stringify(calcRes.body.data.validationIssues));

  // ---- Create quotation: permission gate ----
  const createQuoteNoPerm = makeRes();
  await ctrl.createQuotation({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { packageId }, body: { roomTypeId } }, createQuoteNoPerm);
  assert.equal(createQuoteNoPerm.statusCode, 403);

  const createQuoteRes = makeRes();
  await ctrl.createQuotation({ auth: authAdmin(tenantId), params: { packageId }, body: { roomTypeId } }, createQuoteRes);
  assert.equal(createQuoteRes.statusCode, 201, JSON.stringify(createQuoteRes.body));
  assert.equal(createQuoteRes.body.data.status, "Draft");
  const quotationId = createQuoteRes.body.data._id.toString();

  // ---- Send: missing recipient (no customer, no email supplied) must 400, not throw ----
  const sendMissingRecipient = makeRes();
  await ctrl.sendQuotation({ auth: authAdmin(tenantId), params: { quotationId }, body: { channel: "email" } }, sendMissingRecipient);
  assert.equal(sendMissingRecipient.statusCode, 400, JSON.stringify(sendMissingRecipient.body));

  // ---- Send: happy path. Set pdfUrl directly to avoid depending on headless-Chromium availability in CI — generateQuotationPdf itself is pre-existing, already-wired functionality, not under test here. ----
  await QuotationModel.updateOne({ _id: quotationId, tenantId }, { $set: { pdfUrl: "https://example.com/quotation.pdf" } });

  const sendRes = makeRes();
  await ctrl.sendQuotation({ auth: authAdmin(tenantId), params: { quotationId }, body: { channel: "email", email: "customer@example.com" } }, sendRes);
  assert.equal(sendRes.statusCode, 200, JSON.stringify(sendRes.body));
  assert.equal(sendRes.body.data.quotation.status, "Sent");
  assert.ok(sendRes.body.data.delivery.email, "an email delivery result must be returned");

  const sentAudit = await AuditLogModel.findOne({ tenantId, resource: "Quotation", resourceId: quotationId, action: "package.pricing.send_quotation" }).sort({ createdAt: -1 }).lean();
  assert.ok(sentAudit, "a send_quotation audit row must be written");

  // ---- Send: permission gate ----
  const sendNoPerm = makeRes();
  await ctrl.sendQuotation({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { quotationId }, body: { channel: "email", email: "customer@example.com" } }, sendNoPerm);
  assert.equal(sendNoPerm.statusCode, 403);

  // convertPackageToBooking (which convertQuotationToBooking delegates to)
  // requires the source package to have a customerId — attached now,
  // deliberately after every send assertion above, so it never affects
  // those.
  await PackageModel.updateOne({ _id: packageId, tenantId }, { $set: { customerId: customer._id } });

  // ---- Convert to booking: permission gate ----
  const convertNoPerm = makeRes();
  await ctrl.convertQuotationToBooking({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { quotationId }, body: {} }, convertNoPerm);
  assert.equal(convertNoPerm.statusCode, 403);

  // ---- Convert to booking: happy path — reuses the same roomTypeId the quotation froze, no need to pass it again ----
  const convertRes = makeRes();
  await ctrl.convertQuotationToBooking({ auth: authAdmin(tenantId), params: { quotationId }, body: {} }, convertRes);
  assert.equal(convertRes.statusCode, 201, JSON.stringify(convertRes.body));
  assert.ok(convertRes.body.data.bookingId);
  assert.equal(convertRes.body.data.quotationStatus, "Accepted");

  const convertedQuotation = await QuotationModel.findOne({ _id: quotationId, tenantId }).lean();
  assert.equal(convertedQuotation.status, "Accepted");
  assert.equal(convertedQuotation.convertedBookingId.toString(), convertRes.body.data.bookingId);

  const booking = await BookingHeaderModel.findOne({ _id: convertRes.body.data.bookingId, tenantId }).lean();
  assert.ok(booking, "convert-to-booking must create a real BookingHeaderModel row");
  assert.equal(booking.customerId.toString(), customer._id.toString());

  const convertAudit = await AuditLogModel.findOne({ tenantId, resource: "Quotation", resourceId: quotationId, action: "package.pricing.convert_quotation_to_booking" }).sort({ createdAt: -1 }).lean();
  assert.ok(convertAudit, "a convert_quotation_to_booking audit row must be written");

  // ---- Convert to booking: already converted must 400, not silently create a second booking ----
  const convertAgainRes = makeRes();
  await ctrl.convertQuotationToBooking({ auth: authAdmin(tenantId), params: { quotationId }, body: {} }, convertAgainRes);
  assert.equal(convertAgainRes.statusCode, 400, JSON.stringify(convertAgainRes.body));
});

test("Package Pricing Engine controller: dynamic pricing suggestion — Hajj-season multiplier, high-demand multiplier, never mutates the real package", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/PackagePricingController.js");
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;
  const RoomTypeModel = (await import("../models/RoomTypeModel.js")).default;
  const HotelRateModel = (await import("../models/HotelRateModel.js")).default;
  const PackageModel = (await import("../models/PackageModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-pkg-dynprice-${suffix}`;

  const cleanupModels = [HotelCatalogModel, RoomTypeModel, HotelRateModel, PackageModel, CustomerModel, BookingHeaderModel];
  t.after(async () => { await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId }))); });

  const hotel = await HotelCatalogModel.create({ tenantId, name: `Hotel-${suffix}`, city: "Makkah" });
  const roomRes = makeRes();
  await ctrl.createRoomType({ auth: authAdmin(tenantId), body: { name: `Room-${suffix}`, defaultOccupancy: 2 } }, roomRes);
  const roomTypeId = roomRes.body.data._id.toString();
  await ctrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: hotel._id.toString(), roomTypeId, currency: "USD", pricePerNight: 100, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" } }, makeRes());

  // 9 Dhul Hijjah 1446 — inside the Hajj window (1-13 Dhul Hijjah) by construction.
  const hajjDate = moment.utc("1446/12/9", "iYYYY/iM/iD").toDate();
  const hajjDateEnd = new Date(hajjDate.getTime() + 2 * 24 * 60 * 60 * 1000);

  const createPkgRes = makeRes();
  await ctrl.createPackage({
    auth: authAdmin(tenantId),
    body: {
      name: `Hajj Package ${suffix}`,
      travelStartDate: hajjDate.toISOString(), travelEndDate: hajjDateEnd.toISOString(),
      travelers: { adults: 2 },
      segments: [{ city: "Makkah", hotelCatalogId: hotel._id.toString(), checkIn: hajjDate.toISOString(), checkOut: hajjDateEnd.toISOString(), rooms: 1 }],
      sellingCurrency: "USD"
    }
  }, createPkgRes);
  const packageId = createPkgRes.body.data._id.toString();

  const calcRes = makeRes();
  await ctrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId }, body: {} }, calcRes);
  assert.equal(calcRes.body.data.ready, true, JSON.stringify(calcRes.body.data.validationIssues));
  const originalFinalPrice = calcRes.body.data.roomWisePriceMatrix[0].finalPricePerPerson;

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.getDynamicPricingSuggestion({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { packageId } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Season detected, no demand yet ----
  const lowDemandRes = makeRes();
  await ctrl.getDynamicPricingSuggestion({ auth: authAdmin(tenantId), params: { packageId } }, lowDemandRes);
  assert.equal(lowDemandRes.statusCode, 200, JSON.stringify(lowDemandRes.body));
  assert.equal(lowDemandRes.body.data.season, "Hajj");
  assert.equal(lowDemandRes.body.data.isHighDemand, false);
  assert.equal(lowDemandRes.body.data.combinedMultiplier, lowDemandRes.body.data.seasonMultiplier, "with no demand boost, combined == season multiplier alone");
  const suggestedRow = lowDemandRes.body.data.suggestedMatrix[0];
  assert.equal(suggestedRow.currentFinalPricePerPerson, originalFinalPrice);
  assert.equal(suggestedRow.suggestedFinalPricePerPerson, Math.round(originalFinalPrice * lowDemandRes.body.data.seasonMultiplier * 100) / 100);

  // ---- Push demand over the default threshold (5) with bookings whose travelDate lands near travelStartDate ----
  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "T", lastName: "Est", email: `t.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });
  for (let i = 0; i < 6; i++) {
    await BookingHeaderModel.create({ tenantId, bookingReference: `BK-DEM-${suffix}-${i}`, customerId: customer._id, status: "confirmed", travelDate: hajjDate, totalAmount: 500, currency: "USD" });
  }

  const highDemandRes = makeRes();
  await ctrl.getDynamicPricingSuggestion({ auth: authAdmin(tenantId), params: { packageId } }, highDemandRes);
  assert.equal(highDemandRes.statusCode, 200);
  assert.equal(highDemandRes.body.data.isHighDemand, true);
  assert.ok(highDemandRes.body.data.nearbyBookingCount >= 6);
  assert.equal(highDemandRes.body.data.combinedMultiplier, Math.round(highDemandRes.body.data.seasonMultiplier * highDemandRes.body.data.demandMultiplier * 100) / 100);

  // ---- The suggestion must never mutate the real package ----
  const unchangedPkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
  assert.equal(unchangedPkg.roomWisePriceMatrix[0].finalPricePerPerson, originalFinalPrice, "computing a suggestion must never write to the real package");
});

test("Customer AI Recommendations controller: honest aiAvailable:false when no AI provider is configured, 404 for a missing customer, permission gate", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const custCtrl = await import("../controllers/CustomerController.js");
  const CustomerModel = (await import("../models/CustomerModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-cust-reco-${suffix}`;
  t.after(async () => { await CustomerModel.deleteMany({ tenantId }); });

  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-R-${suffix}`, firstName: "R", lastName: "Eco", email: `r.${suffix}@example.com`, phone: `+92301${suffix}`.slice(0, 15) });
  // GetCustomerRecommendations mirrors GetCustomer's existing convention
  // (checked against every other read in controllers/CustomerController.js):
  // it gates on the literal customer.read/customers.read permission key,
  // with no "admin" string bypass — a real Administrator role holds
  // customer.read via the seeded permission set, not a code-level shortcut.
  const authCustomerReader = (tid) => ({ tenantId: tid, id: "tester", userId: "tester", permissions: ["customer.read"] });

  const noPermRes = makeRes();
  await custCtrl.GetCustomerRecommendations({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { customerId: customer._id.toString() } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  const notFoundRes = makeRes();
  await custCtrl.GetCustomerRecommendations({ auth: authCustomerReader(tenantId), params: { customerId: new mongoose.Types.ObjectId().toString() } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  // This environment has no AI provider credentials configured — the same
  // "honest failure, never fabricate" path every other AI call site in this
  // codebase exercises when nothing is reachable.
  const recoRes = makeRes();
  await custCtrl.GetCustomerRecommendations({ auth: authCustomerReader(tenantId), params: { customerId: customer._id.toString() } }, recoRes);
  assert.equal(recoRes.statusCode, 200, JSON.stringify(recoRes.body));
  assert.equal(recoRes.body.data.aiAvailable, false);
  assert.deepEqual(recoRes.body.data.recommendations, []);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
