import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Issue 1 (booking reference generator): CreateBooking must mint references
// through NumberGeneratorService (tenant-scoped, atomic, gap-aware) instead
// of Math.random(), and bookingReference uniqueness must be per-tenant, not
// global. See CLAUDE.md / PRD Issue 1.

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

const authFor = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin", "bookings.create", "booking.create"] });

test("Booking reference generation: tenant-scoped, atomic, collision-free", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { CreateBooking } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const ResourceSequenceModel = (await import("../models/ResourceSequenceModel.js")).default;
  const GeneratedNumberModel = (await import("../models/GeneratedNumberModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;

  const suffix = Date.now();
  const tenantA = `test-bkref-a-${suffix}`;
  const tenantB = `test-bkref-b-${suffix}`;
  const tenantC = `test-bkref-c-${suffix}`; // deliberately never gets a numbering scheme

  t.after(async () => {
    const tenantIds = [tenantA, tenantB, tenantC];
    await Promise.all([
      BookingHeaderModel.deleteMany({ tenantId: { $in: tenantIds } }),
      CustomerModel.deleteMany({ tenantId: { $in: tenantIds } }),
      NumberingSchemeModel.deleteMany({ tenantId: { $in: tenantIds } }),
      ResourceSequenceModel.deleteMany({ tenantId: { $in: tenantIds } }),
      GeneratedNumberModel.deleteMany({ tenantId: { $in: tenantIds } })
    ]);
  });

  const makeCustomer = async (tenantId, tag) => CustomerModel.create({
    tenantId,
    customerCode: `CUST-${tag}-${suffix}`,
    firstName: "Test",
    lastName: tag,
    email: `${tag}.${suffix}@example.com`,
    phone: `+100000${suffix}`.slice(0, 15)
  });

  const customerA = await makeCustomer(tenantA, "A");
  const customerB = await makeCustomer(tenantB, "B");
  const customerC = await makeCustomer(tenantC, "C");

  await NumberGeneratorService.createScheme(tenantA, { resourceType: "Booking", prefix: "BK", includeYear: true, sequenceLength: 6, isDefault: true }, "tester");
  await NumberGeneratorService.createScheme(tenantB, { resourceType: "Booking", prefix: "BK", includeYear: true, sequenceLength: 6, isDefault: true }, "tester");
  // tenantC intentionally left unconfigured.

  const createReq = (tenantId, customerId) => ({
    auth: authFor(tenantId),
    body: { customerId: customerId.toString() },
    requestId: `req-${Math.random()}`
  });

  // Two concurrent creates under the same tenant must never collide.
  const [res1, res2] = await Promise.all([
    (async () => { const res = makeRes(); await CreateBooking(createReq(tenantA, customerA._id), res); return res; })(),
    (async () => { const res = makeRes(); await CreateBooking(createReq(tenantA, customerA._id), res); return res; })()
  ]);
  assert.equal(res1.statusCode, 201, JSON.stringify(res1.body));
  assert.equal(res2.statusCode, 201, JSON.stringify(res2.body));
  const refsA = [res1.body.data.bookingNumber, res2.body.data.bookingNumber];
  assert.notEqual(refsA[0], refsA[1], "concurrent creates under the same tenant must not collide");
  const year = new Date().getUTCFullYear();
  assert.deepEqual(refsA.sort(), [`BK-${year}-000001`, `BK-${year}-000002`].sort());

  // Two independent tenants can each hold their own BK-<year>-000001.
  const resB = makeRes();
  await CreateBooking(createReq(tenantB, customerB._id), resB);
  assert.equal(resB.statusCode, 201, JSON.stringify(resB.body));
  assert.equal(resB.body.data.bookingNumber, `BK-${year}-000001`, "tenant B's counter is independent of tenant A's");

  // Both bookings are persisted under the tenant-scoped compound index, not a global unique field.
  const stored = await BookingHeaderModel.find({ tenantId: tenantA }).lean();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((b) => b.bookingReference).sort(), refsA.sort());

  // No numbering scheme configured for the tenant -> honest 422, never a generic 500 crash.
  const resC = makeRes();
  await CreateBooking(createReq(tenantC, customerC._id), resC);
  assert.equal(resC.statusCode, 422, JSON.stringify(resC.body));
  assert.match(resC.body.message, /No numbering scheme configured/);
  assert.equal(await BookingHeaderModel.countDocuments({ tenantId: tenantC }), 0, "no booking should be created when reference generation fails");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
