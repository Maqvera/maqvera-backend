import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// PRD A5 remainder — proves BookingVoucherService.generateVoucher reads the
// manual/AI-parsed hotel path (BookingServiceModel.details, PRD A8) when no
// GDS HotelBookingModel record exists, instead of silently producing an
// empty typeDetails.hotels; and PRD A10 — proves generation is blocked with
// a named missing-field list when required data (a guest/traveler) is absent.
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

test("BookingVoucherService.generateVoucher renders manual (non-GDS) hotel details from BookingServiceModel.details", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingTravelerModel = (await import("../models/BookingTravelerModel.js")).default;
  const BookingServiceModel = (await import("../models/BookingServiceModel.js")).default;
  const BookingVoucherModel = (await import("../models/BookingVoucherModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;
  const BookingVoucherService = (await import("../services/BookingVoucherService.js")).default;

  const suffix = `bvoucher-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId });
    await BookingTravelerModel.deleteMany({ tenantId });
    await BookingServiceModel.deleteMany({ tenantId });
    await BookingVoucherModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
    await NumberingSchemeModel.deleteMany({ tenantId });
  });

  await NumberGeneratorService.createScheme(tenantId, {
    resourceType: "Voucher", prefix: "CV", includeYear: true, sequenceLength: 6, allowGaps: true, isDefault: true
  }, "test");

  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Jane", lastName: "Doe", email: `${suffix}@example.com`, phone: "+923001234567"
  });

  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: customer._id, status: "confirmed", totalAmount: 1000
  });

  await BookingTravelerModel.create({
    bookingId: booking._id, tenantId, customerId: customer._id, isPrimary: true, firstName: "Jane", lastName: "Doe", status: "active",
    customerSnapshot: { snapshotName: "Jane Doe" }
  });

  await BookingServiceModel.create({
    bookingId: booking._id, tenantId, serviceType: "hotel", serviceName: "Swissotel Al Maqam",
    sellingPrice: 800, status: "active",
    details: {
      hotelName: "Swissotel Al Maqam", roomType: "Deluxe Twin", adultCount: 2, childCount: 0, infantCount: 0,
      checkIn: new Date("2026-09-01"), checkOut: new Date("2026-09-05"), nights: 4, mealPlan: "half_board",
      roomQuantity: 1, overrideNights: null, overrideNightsReason: null, overriddenBy: null, overriddenAt: null
    }
  });

  const voucher = await BookingVoucherService.generateVoucher(booking._id, tenantId, "tester");

  assert.ok(voucher.voucherNumber.startsWith("CV-"));
  assert.equal(voucher.snapshotData.typeDetails.hotels.length, 1, "manual BookingServiceModel hotel line must populate typeDetails.hotels");
  const hotel = voucher.snapshotData.typeDetails.hotels[0];
  assert.equal(hotel.hotelName, "Swissotel Al Maqam");
  assert.equal(hotel.roomType, "Deluxe Twin");
  assert.equal(hotel.roomsCount, 1);
  assert.equal(hotel.guestsCount, 2);
});

test("BookingVoucherService.generateVoucher blocks generation when the booking has no traveler", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;
  const BookingVoucherService = (await import("../services/BookingVoucherService.js")).default;

  const suffix = `bvoucher-noguest-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
    await NumberingSchemeModel.deleteMany({ tenantId });
  });

  await NumberGeneratorService.createScheme(tenantId, {
    resourceType: "Voucher", prefix: "CV", includeYear: true, sequenceLength: 6, allowGaps: true, isDefault: true
  }, "test");

  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "John", lastName: "Roe", email: `${suffix}@example.com`, phone: "+923001234568"
  });

  const booking = await BookingHeaderModel.create({
    tenantId, bookingReference: `BK-${suffix}`, customerId: customer._id, status: "confirmed", totalAmount: 500
  });

  await assert.rejects(
    () => BookingVoucherService.generateVoucher(booking._id, tenantId, "tester"),
    /Cannot generate document — missing required field\(s\).*guest\/traveler/
  );
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
