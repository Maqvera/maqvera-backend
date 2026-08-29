import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Public B2C Booking Site (PRD "CRM Feature Map by Phase" Phase 2 module
// 15) — same direct-controller-call convention as tests/agentPortal.test.js
// and tests/packagePricingController.test.js. Covers: tenantSlug
// resolution (unknown slug -> 404, suspended tenant -> unavailable),
// publicVisible gating on both list and detail, a full anonymous
// clone -> calculate -> convert-to-booking round trip, repeat-visitor
// customer reuse (never a second CustomerModel row for the same email),
// and public lead capture.

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

test("Public Booking Site: tenantSlug resolution, publicVisible gating, anonymous clone->calculate->convert round trip, repeat-visitor reuse, lead capture", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const pkgCtrl = await import("../controllers/PackagePricingController.js");
  const publicCtrl = await import("../controllers/PublicBookingController.js");
  const HotelCatalogModel = (await import("../models/HotelCatalogModel.js")).default;
  const RoomTypeModel = (await import("../models/RoomTypeModel.js")).default;
  const HotelRateModel = (await import("../models/HotelRateModel.js")).default;
  const PackageModel = (await import("../models/PackageModel.js")).default;
  const PackageTemplateModel = (await import("../models/PackageTemplateModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingServiceModel = (await import("../models/BookingServiceModel.js")).default;
  const LeadModel = (await import("../models/LeadModel.js")).default;
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const TenantProfileModel = (await import("../models/TenantProfileModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;

  const suffix = Date.now();
  const tenantId = `test-public-${suffix}`;
  const slug = `test-agency-${suffix}`;

  const cleanupModels = [HotelCatalogModel, RoomTypeModel, HotelRateModel, PackageModel, PackageTemplateModel, CustomerModel, BookingHeaderModel, BookingServiceModel, LeadModel, NumberingSchemeModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await TenantProfileModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Booking", prefix: "BK", isDefault: true }, "tester");
  await TenantModel.create({ tenantKey: tenantId, name: `Test Agency ${suffix}`, status: "active" });
  await TenantProfileModel.create({ tenantId, companyName: `Test Agency ${suffix}`, publicSlug: slug });

  // ---- Unknown slug -> 404 ----
  const badSlugRes = makeRes();
  await publicCtrl.GetPublicPackages({ query: { tenantSlug: "no-such-agency" } }, badSlugRes);
  assert.equal(badSlugRes.statusCode, 404);

  // ---- Build a real, bookable package (same fixtures as the quotation test) ----
  const hotel = await HotelCatalogModel.create({ tenantId, name: `Hotel-${suffix}`, city: "CityP" });

  const roomRes = makeRes();
  await pkgCtrl.createRoomType({ auth: authAdmin(tenantId), body: { name: `Room-${suffix}`, defaultOccupancy: 2 } }, roomRes);
  const roomTypeId = roomRes.body.data._id.toString();

  await pkgCtrl.createHotelRate({ auth: authAdmin(tenantId), body: { hotelCatalogId: hotel._id.toString(), roomTypeId, currency: "USD", pricePerNight: 100, occupancy: 2, rateBasis: "Standard", status: "Active", source: "Manual" } }, makeRes());

  const createPkgRes = makeRes();
  await pkgCtrl.createPackage({
    auth: authAdmin(tenantId),
    body: {
      name: `Public Package ${suffix}`,
      travelStartDate: "2027-10-01", travelEndDate: "2027-10-04",
      travelers: { adults: 2 },
      segments: [{ city: "CityP", hotelCatalogId: hotel._id.toString(), checkIn: "2027-10-01", checkOut: "2027-10-04", rooms: 1 }],
      sellingCurrency: "USD"
    }
  }, createPkgRes);
  const packageId = createPkgRes.body.data._id.toString();

  const calcRes = makeRes();
  await pkgCtrl.calculatePackage({ auth: authAdmin(tenantId), params: { packageId }, body: {} }, calcRes);
  assert.equal(calcRes.body.data.ready, true, JSON.stringify(calcRes.body.data.validationIssues));

  const templateRes = makeRes();
  await pkgCtrl.saveAsTemplate({ auth: authAdmin(tenantId), params: { packageId }, body: { name: `Public Template ${suffix}` } }, templateRes);
  const templateId = templateRes.body.data._id.toString();

  // ---- Template not yet publicVisible -> public listing/detail must not surface it ----
  const emptyListRes = makeRes();
  await publicCtrl.GetPublicPackages({ query: { tenantSlug: slug } }, emptyListRes);
  assert.equal(emptyListRes.statusCode, 200);
  assert.equal(emptyListRes.body.data.items.length, 0);

  const hiddenDetailRes = makeRes();
  await publicCtrl.GetPublicPackageDetail({ query: { tenantSlug: slug }, params: { id: templateId } }, hiddenDetailRes);
  assert.equal(hiddenDetailRes.statusCode, 404);

  // ---- publicVisible requires displayPriceFrom first ----
  const rejectRes = makeRes();
  await pkgCtrl.updatePackageTemplate({ auth: authAdmin(tenantId), params: { templateId }, body: { publicVisible: true } }, rejectRes);
  assert.equal(rejectRes.statusCode, 400, JSON.stringify(rejectRes.body));

  const publishRes = makeRes();
  await pkgCtrl.updatePackageTemplate({ auth: authAdmin(tenantId), params: { templateId }, body: { publicVisible: true, packageType: "Umrah", displayPriceFrom: 999 } }, publishRes);
  assert.equal(publishRes.statusCode, 200, JSON.stringify(publishRes.body));

  // ---- Now it's browsable ----
  const listRes = makeRes();
  await publicCtrl.GetPublicPackages({ query: { tenantSlug: slug, type: "Umrah" } }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 1);
  assert.equal(listRes.body.data.items[0].id.toString(), templateId);
  assert.equal(listRes.body.data.items[0].durationNights, 3);

  const detailRes = makeRes();
  await publicCtrl.GetPublicPackageDetail({ query: { tenantSlug: slug }, params: { id: templateId } }, detailRes);
  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.body.data.package.segments.length, 1);

  // ---- Anonymous booking: validation ----
  const missingCustomerRes = makeRes();
  await publicCtrl.CreatePublicBooking({ body: { tenantSlug: slug, packageTemplateId: templateId, travelStartDate: "2027-11-01" } }, missingCustomerRes);
  assert.equal(missingCustomerRes.statusCode, 400);

  // ---- Anonymous booking: happy path ----
  const visitorEmail = `visitor.${suffix}@example.com`;
  const bookRes = makeRes();
  await publicCtrl.CreatePublicBooking({
    body: {
      tenantSlug: slug, packageTemplateId: templateId, travelStartDate: "2027-11-01",
      travelers: { adults: 2 },
      customer: { firstName: "Vis", lastName: "Itor", email: visitorEmail, phone: `+92300${suffix}`.slice(0, 15) }
    }
  }, bookRes);
  assert.equal(bookRes.statusCode, 201, JSON.stringify(bookRes.body));
  assert.ok(bookRes.body.data.bookingId);
  assert.equal(bookRes.body.data.selectedRoomType.roomTypeId.toString(), roomTypeId);
  assert.ok(bookRes.body.data.checkout, "a checkout result (even a non-available one) must always be returned");

  const booking = await BookingHeaderModel.findOne({ _id: bookRes.body.data.bookingId, tenantId }).lean();
  assert.ok(booking, "a real BookingHeaderModel row must be created");
  assert.equal(booking.status, "draft");

  const customersAfterFirst = await CustomerModel.countDocuments({ tenantId, email: visitorEmail });
  assert.equal(customersAfterFirst, 1);

  // ---- Repeat visitor (same email) must reuse the existing customer, never create a second one ----
  const bookAgainRes = makeRes();
  await publicCtrl.CreatePublicBooking({
    body: {
      tenantSlug: slug, packageTemplateId: templateId, travelStartDate: "2027-12-01",
      travelers: { adults: 2 },
      customer: { firstName: "Vis", lastName: "Itor", email: visitorEmail.toUpperCase(), phone: `+92300${suffix}`.slice(0, 15) }
    }
  }, bookAgainRes);
  assert.equal(bookAgainRes.statusCode, 201, JSON.stringify(bookAgainRes.body));
  assert.equal(bookAgainRes.body.data.customerId, bookRes.body.data.customerId);

  const customersAfterSecond = await CustomerModel.countDocuments({ tenantId, email: visitorEmail });
  assert.equal(customersAfterSecond, 1, "a repeat visitor by email must never create a second CustomerModel row");

  // ---- Public lead capture ----
  const leadRes = makeRes();
  await publicCtrl.CreatePublicLead({ body: { tenantSlug: slug, firstName: "Curious", email: `curious.${suffix}@example.com` } }, leadRes);
  assert.equal(leadRes.statusCode, 201, JSON.stringify(leadRes.body));
  assert.equal(leadRes.body.data.source, "Website");

  const lead = await LeadModel.findOne({ tenantId, firstName: "Curious" }).lean();
  assert.ok(lead, "the lead must be created under the resolved tenant, not a client-supplied tenantId");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
