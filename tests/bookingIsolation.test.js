import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Cross-tenant + cross-branch isolation check for BookingController.js after
// its getAccessScope migration (docs/06-external-integrations/02-tenant-isolation-audit.md §7/§8).

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

const authFor = (tenantId, branchId, roleScope) => ({ tenantId, branchId, id: "tester", userId: "tester", permissions: ["admin", "bookings.read", "booking.read"], roleScope });

test("Bookings are isolated by tenant AND by branch (branch-scoped roles), tenant-wide for tenant-scoped roles", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { ListBookings, GetBooking } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-booking-iso-a-${suffix}`;
  const tenantB = `test-booking-iso-b-${suffix}`;
  const branch1 = "BR1";
  const branch2 = "BR2";

  t.after(async () => {
    await BookingHeaderModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  const bookingA1 = await BookingHeaderModel.create({
    tenantId: tenantA, branchId: branch1, bookingReference: `BK-A1-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });
  await BookingHeaderModel.create({
    tenantId: tenantA, branchId: branch2, bookingReference: `BK-A2-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });
  await BookingHeaderModel.create({
    tenantId: tenantB, branchId: branch1, bookingReference: `BK-B1-${suffix}`, customerId: new mongoose.Types.ObjectId()
  });

  const listAndGetRefs = async (tenantId, branchId, roleScope) => {
    const res = makeRes();
    await ListBookings({ auth: authFor(tenantId, branchId, roleScope), query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.data.map((b) => b.bookingNumber);
  };

  // Branch-scoped: only their own branch's booking.
  assert.deepEqual(await listAndGetRefs(tenantA, branch1, "branch"), [`BK-A1-${suffix}`]);
  assert.deepEqual(await listAndGetRefs(tenantA, branch2, "branch"), [`BK-A2-${suffix}`]);
  assert.deepEqual(await listAndGetRefs(tenantB, branch1, "branch"), [`BK-B1-${suffix}`]);

  // Tenant-scoped: every branch within the tenant, never another tenant.
  const tenantAAll = await listAndGetRefs(tenantA, branch1, "tenant");
  assert.deepEqual(tenantAAll.sort(), [`BK-A1-${suffix}`, `BK-A2-${suffix}`].sort());

  // A branch-scoped caller in branch2 cannot fetch branch1's booking by ID.
  const crossBranchRes = makeRes();
  await GetBooking({ auth: authFor(tenantA, branch2, "branch"), params: { bookingId: bookingA1._id.toString() } }, crossBranchRes);
  assert.equal(crossBranchRes.statusCode, 404, JSON.stringify(crossBranchRes.body));

  // Its own branch's booking is fetchable.
  const ownBranchRes = makeRes();
  await GetBooking({ auth: authFor(tenantA, branch1, "branch"), params: { bookingId: bookingA1._id.toString() } }, ownBranchRes);
  assert.equal(ownBranchRes.statusCode, 200, JSON.stringify(ownBranchRes.body));

  // No auth context at all -> rejected, never defaulted.
  const noAuthRes = makeRes();
  await ListBookings({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
