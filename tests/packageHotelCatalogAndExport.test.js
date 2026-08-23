import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { buildFlyerSegmentData } from "../services/PackageFlyerService.js";

dotenv.config();

// Package Pricing Engine — Hotel Catalog master-data extension (PRD §8) and
// XLSX rate export (PRD §113). Same direct-controller-call, dbAvailable-gated
// convention as tests/packagePricingController.test.js.

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
  headers: {},
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  setHeader(name, value) { this.headers[name] = value; return this; },
  send(payload) { this.body = payload; return this; }
});

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

// ---- Pure unit tests (no DB, no Chromium) ----

test("buildFlyerSegmentData guards every new hotel field to null/[] when the hotel has none of them set", () => {
  const segment = { city: "Makkah", checkIn: "2027-07-01", checkOut: "2027-07-04" };
  const bareHotel = { _id: "h1", name: "Bare Hotel" }; // predates the Gap A fields entirely
  const result = buildFlyerSegmentData(segment, bareHotel);
  assert.equal(result.hotelName, "Bare Hotel");
  assert.equal(result.hotelImage, null);
  assert.equal(result.hotelDescription, null);
  assert.deepEqual(result.hotelAmenities, []);
  assert.equal(result.hotelCheckInTime, null);
  assert.equal(result.hotelCheckOutTime, null);
  assert.equal(result.nights, 3);
});

test("buildFlyerSegmentData never throws when hotel is null (segment references a deleted/missing catalog entry)", () => {
  const segment = { city: "Madinah", checkIn: "2027-07-04", checkOut: "2027-07-06" };
  assert.doesNotThrow(() => buildFlyerSegmentData(segment, null));
  const result = buildFlyerSegmentData(segment, null);
  assert.equal(result.hotelName, null);
});

test("buildFlyerSegmentData surfaces the new hotel fields when populated", () => {
  const segment = { city: "Makkah", checkIn: "2027-07-01", checkOut: "2027-07-04" };
  const hotel = { name: "Full Hotel", images: ["https://example.com/a.jpg", "https://example.com/b.jpg"], description: "Great stay", amenities: ["Wifi"], checkInTime: "14:00", checkOutTime: "12:00" };
  const result = buildFlyerSegmentData(segment, hotel);
  assert.equal(result.hotelImage, "https://example.com/a.jpg");
  assert.equal(result.hotelDescription, "Great stay");
  assert.deepEqual(result.hotelAmenities, ["Wifi"]);
  assert.equal(result.hotelCheckInTime, "14:00");
  assert.equal(result.hotelCheckOutTime, "12:00");
});

// ---- DB-gated schema/controller tests ----

test("HotelCatalog: new PRD §8 fields save and load correctly through the controller", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/PackagePricingController.js");
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-hotel-catalog-${suffix}`;
  t.after(async () => {
    await HotelCatalogModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  const createRes = makeRes();
  await ctrl.createHotelCatalog({
    auth: authAdmin(tenantId),
    body: {
      name: `Hotel ${suffix}`, city: "Makkah",
      latitude: 21.4225, longitude: 39.8262,
      distanceFromLandmark: { label: "Haram", km: 0.3 },
      distanceFromAirport: 90,
      checkInTime: "14:00", checkOutTime: "12:00",
      description: "Near the Haram.", images: ["https://example.com/hotel.jpg"], logoUrl: "https://example.com/logo.png",
      shuttleAvailable: true, mealPlansOffered: ["Breakfast", "Half Board"],
      cancellationPolicy: "Free up to 48h before check-in.", supplierHotelCode: "SUP-123"
    }
  }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  const hotelId = createRes.body.data._id.toString();

  const stored = await HotelCatalogModel.findOne({ _id: hotelId, tenantId }).lean();
  assert.equal(stored.latitude, 21.4225);
  assert.equal(stored.distanceFromLandmark.label, "Haram");
  assert.equal(stored.distanceFromAirport, 90);
  assert.equal(stored.checkInTime, "14:00");
  assert.deepEqual(stored.images, ["https://example.com/hotel.jpg"]);
  assert.equal(stored.shuttleAvailable, true);
  assert.deepEqual(stored.mealPlansOffered, ["Breakfast", "Half Board"]);
  assert.equal(stored.cancellationPolicy, "Free up to 48h before check-in.");
  assert.equal(stored.supplierHotelCode, "SUP-123");

  // A hotel with none of these fields set (pre-existing record) must still list/load without error.
  const bareHotel = await HotelCatalogModel.create({ tenantId, name: `Bare ${suffix}`, city: "Madinah" });
  const listRes = makeRes();
  await ctrl.listHotelCatalog({ auth: authAdmin(tenantId), query: {} }, listRes);
  assert.equal(listRes.statusCode, 200, JSON.stringify(listRes.body));
  assert.equal(listRes.body.data.items.length, 2);

  // Invalid mealPlansOffered value must be rejected, not silently accepted.
  const badRes = makeRes();
  await ctrl.createHotelCatalog({ auth: authAdmin(tenantId), body: { name: `Bad ${suffix}`, city: "Makkah", mealPlansOffered: ["Not A Real Plan"] } }, badRes);
  assert.equal(badRes.statusCode, 400, JSON.stringify(badRes.body));

  // Update goes through the audit trail like every other master/rate PATCH.
  const updateRes = makeRes();
  await ctrl.updateHotelCatalog({ auth: authAdmin(tenantId), params: { hotelCatalogId: bareHotel._id.toString() }, body: { description: "Now has a description.", reason: "Data enrichment" } }, updateRes);
  assert.equal(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.equal(updateRes.body.data.description, "Now has a description.");

  const auditRow = await AuditLogModel.findOne({ tenantId, resource: "HotelCatalog", resourceId: bareHotel._id.toString() }).sort({ createdAt: -1 }).lean();
  assert.ok(auditRow, "an AuditLogModel row must be written for the hotel catalog update");
  assert.equal(auditRow.details.reason, "Data enrichment");
});

test("Rate export: GET .../hotel-rates/export?format=xlsx produces a valid workbook with the same columns as CSV", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/PackagePricingController.js");
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;
  const RoomTypeModel = (await import("../models/RoomTypeModel.js")).default;
  const HotelRateModel = (await import("../models/HotelRateModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-xlsx-export-${suffix}`;
  t.after(async () => {
    await Promise.all([HotelCatalogModel.deleteMany({ tenantId }), RoomTypeModel.deleteMany({ tenantId }), HotelRateModel.deleteMany({ tenantId })]);
  });

  const hotel = await HotelCatalogModel.create({ tenantId, name: `Hotel ${suffix}`, city: "Makkah" });
  const roomType = await RoomTypeModel.create({ tenantId, name: `Double ${suffix}`, defaultOccupancy: 2 });
  await HotelRateModel.create({ tenantId, hotelCatalogId: hotel._id, roomTypeId: roomType._id, currency: "USD", pricePerNight: 100, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" });

  const csvRes = makeRes();
  await ctrl.exportHotelRates({ auth: authAdmin(tenantId), query: {} }, csvRes);
  assert.equal(csvRes.statusCode, 200, JSON.stringify(csvRes.body));
  assert.equal(csvRes.headers["Content-Type"], "text/csv");
  const csvHeaders = csvRes.body.split("\n")[0].split(",");

  const xlsxRes = makeRes();
  await ctrl.exportHotelRates({ auth: authAdmin(tenantId), query: { format: "xlsx" } }, xlsxRes);
  assert.equal(xlsxRes.statusCode, 200, JSON.stringify(xlsxRes.body));
  assert.equal(xlsxRes.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(Buffer.isBuffer(xlsxRes.body), "xlsx export must send a Buffer");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsxRes.body);
  const worksheet = workbook.worksheets[0];
  const xlsxHeaders = worksheet.getRow(1).values.slice(1); // ExcelJS row.values is 1-indexed with a leading empty slot
  assert.deepEqual(xlsxHeaders, csvHeaders, "xlsx and csv exports must have identical columns, in the same order");
  assert.ok(worksheet.rowCount >= 2, "the created hotel rate must appear as a data row");

  // Omitted format must still default to CSV (unchanged existing behavior).
  const defaultRes = makeRes();
  await ctrl.exportHotelRates({ auth: authAdmin(tenantId), query: {} }, defaultRes);
  assert.equal(defaultRes.headers["Content-Type"], "text/csv");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
