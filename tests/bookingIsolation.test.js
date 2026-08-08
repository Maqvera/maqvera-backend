import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Company-level isolation check for BookingController.js — see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md.
// Bookings are shared business data within a tenant: every authenticated
// user of a company sees all of that company's bookings. Tenant isolation
// itself remains absolute.

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

const authFor = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin", "bookings.read", "booking.read"] });

test("Bookings are shared company-wide within a tenant, and tenant isolation remains absolute", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { ListBookings, GetBooking } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-booking-iso-a-${suffix}`;
  const tenantB = `test-booking-iso-b-${suffix}`;

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  // Two bookings under tenant A, plus one under tenant B.
  const bookingA1 = await BookingHeaderModel.create({
    tenantId: tenantA, bookingReference: `BK-A1-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });
  const bookingA2 = await BookingHeaderModel.create({
    tenantId: tenantA, bookingReference: `BK-A2-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });
  await BookingHeaderModel.create({
    tenantId: tenantB, bookingReference: `BK-B1-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });

  const listRefs = async (tenantId) => {
    const res = makeRes();
    await ListBookings({ auth: authFor(tenantId), query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.data.map((b) => b.bookingNumber);
  };

  // Any employee of tenant A sees BOTH tenant A bookings.
  const seenByTenantA = await listRefs(tenantA);
  assert.deepEqual(seenByTenantA.sort(), [`BK-A1-${suffix}`, `BK-A2-${suffix}`].sort());

  // Tenant B only ever sees its own booking.
  assert.deepEqual(await listRefs(tenantB), [`BK-B1-${suffix}`]);

  // A tenant A employee can fetch either tenant A booking directly by ID.
  const sameTenantRes = makeRes();
  await GetBooking({ auth: authFor(tenantA), params: { bookingId: bookingA1._id.toString() } }, sameTenantRes);
  assert.equal(sameTenantRes.statusCode, 200, JSON.stringify(sameTenantRes.body));

  // But tenant B can never fetch tenant A's booking.
  const crossTenantRes = makeRes();
  await GetBooking({ auth: authFor(tenantB), params: { bookingId: bookingA2._id.toString() } }, crossTenantRes);
  assert.equal(crossTenantRes.statusCode, 404, JSON.stringify(crossTenantRes.body));

  // No auth context at all -> rejected, never defaulted.
  const noAuthRes = makeRes();
  await ListBookings({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
