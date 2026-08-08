import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Company-level isolation check for BookingController.js — see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md.
// Bookings are shared business data within a tenant: every authenticated
// user of a company sees all of that company's bookings regardless of their
// own branchId (purely descriptive now, never an access boundary). Tenant
// isolation itself remains absolute.

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

const authFor = (tenantId, branchId) => ({ tenantId, branchId, id: "tester", userId: "tester", permissions: ["admin", "bookings.read", "booking.read"] });

test("Bookings are shared company-wide within a tenant (branchId is descriptive only, never enforced), and tenant isolation remains absolute", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { ListBookings, GetBooking } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-booking-iso-a-${suffix}`;
  const tenantB = `test-booking-iso-b-${suffix}`;

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  // Two bookings under tenant A, deliberately tagged with different
  // (now purely descriptive) branchId values, plus one under tenant B.
  const bookingA1 = await BookingHeaderModel.create({
    tenantId: tenantA, branchId: "OFFICE-1", bookingReference: `BK-A1-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });
  const bookingA2 = await BookingHeaderModel.create({
    tenantId: tenantA, branchId: "OFFICE-2", bookingReference: `BK-A2-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });
  await BookingHeaderModel.create({
    tenantId: tenantB, branchId: "OFFICE-1", bookingReference: `BK-B1-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });

  const listRefs = async (tenantId, branchId) => {
    const res = makeRes();
    await ListBookings({ auth: authFor(tenantId, branchId), query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.data.map((b) => b.bookingNumber);
  };

  // Any employee of tenant A sees BOTH tenant A bookings, regardless of
  // which office their own token says they belong to.
  const seenFromOffice1 = await listRefs(tenantA, "OFFICE-1");
  const seenFromOffice2 = await listRefs(tenantA, "OFFICE-2");
  const seenFromNoOffice = await listRefs(tenantA, null);
  assert.deepEqual(seenFromOffice1.sort(), [`BK-A1-${suffix}`, `BK-A2-${suffix}`].sort());
  assert.deepEqual(seenFromOffice2.sort(), [`BK-A1-${suffix}`, `BK-A2-${suffix}`].sort());
  assert.deepEqual(seenFromNoOffice.sort(), [`BK-A1-${suffix}`, `BK-A2-${suffix}`].sort());

  // Tenant B only ever sees its own booking.
  assert.deepEqual(await listRefs(tenantB, "OFFICE-1"), [`BK-B1-${suffix}`]);

  // A tenant A employee tagged with a different office than the booking's
  // own can still fetch it directly by ID — no branch gate on reads.
  const crossOfficeRes = makeRes();
  await GetBooking({ auth: authFor(tenantA, "OFFICE-2"), params: { bookingId: bookingA1._id.toString() } }, crossOfficeRes);
  assert.equal(crossOfficeRes.statusCode, 200, JSON.stringify(crossOfficeRes.body));

  // But tenant B can never fetch tenant A's booking, regardless of office.
  const crossTenantRes = makeRes();
  await GetBooking({ auth: authFor(tenantB, "OFFICE-1"), params: { bookingId: bookingA2._id.toString() } }, crossTenantRes);
  assert.equal(crossTenantRes.statusCode, 404, JSON.stringify(crossTenantRes.body));

  // No auth context at all -> rejected, never defaulted.
  const noAuthRes = makeRes();
  await ListBookings({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
