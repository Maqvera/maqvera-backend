import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Pilgrim Kit Management (PRD "CRM Feature Map by Phase" Phase 4 module 40)
// — same direct-controller-call convention as tests/myTasks.test.js.

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

// BookingController.js's Task/Kit endpoints check the literal bookings.read/
// bookings.update permission keys directly (same convention as
// ListBookingTasks/AddBookingTask), no blanket "admin" bypass — a real
// Administrator role holds these via the seeded permission set, not a
// code-level shortcut.
const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["bookings.read", "booking.read", "bookings.update", "booking.update"] });

test("Pilgrim Kit: find-or-create on first item, distribution tracking, permission gate, tenant scope", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const PilgrimKitModel = (await import("../models/PilgrimKitModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-kit-${suffix}`;

  t.after(async () => {
    await Promise.all([
      BookingHeaderModel.deleteMany({ tenantId }),
      CustomerModel.deleteMany({ tenantId }),
      PilgrimKitModel.deleteMany({ tenantId })
    ]);
  });

  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "K", lastName: "It", email: `kit.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });
  const booking = await BookingHeaderModel.create({ tenantId, bookingReference: `BK-${suffix}`, customerId: customer._id, totalAmount: 100, currency: "USD" });

  // ---- No kit yet: honest empty shape, never 404/500 ----
  const emptyRes = makeRes();
  await ctrl.GetBookingKit({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() } }, emptyRes);
  assert.equal(emptyRes.statusCode, 200);
  assert.deepEqual(emptyRes.body.data.items, []);

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.AddBookingKitItem({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, params: { bookingId: booking._id.toString() }, body: { itemName: "Ihram" } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Add first item: find-or-creates the kit ----
  const addRes = makeRes();
  await ctrl.AddBookingKitItem({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() }, body: { itemName: "Ihram", quantity: 2 } }, addRes);
  assert.equal(addRes.statusCode, 201, JSON.stringify(addRes.body));
  assert.equal(addRes.body.data.items.length, 1);
  assert.equal(addRes.body.data.customerId.toString(), customer._id.toString());

  // ---- Add a second item onto the SAME kit row (unique bookingId index) ----
  const addRes2 = makeRes();
  await ctrl.AddBookingKitItem({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() }, body: { itemName: "SIM Card" } }, addRes2);
  assert.equal(addRes2.statusCode, 201);
  assert.equal(addRes2.body.data.items.length, 2);
  const kitCount = await PilgrimKitModel.countDocuments({ tenantId, bookingId: booking._id });
  assert.equal(kitCount, 1, "there must be exactly one kit row per booking");

  // The fake res.json() below stores the payload object as-is (no real JSON
  // round-trip), so subdocument _id fields stay live ObjectId instances —
  // always compare via .toString(), never ===.
  const simItemId = addRes2.body.data.items.find((i) => i.itemName === "SIM Card")._id.toString();

  // ---- Mark an item distributed ----
  const distributeRes = makeRes();
  await ctrl.UpdateBookingKitItem({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString(), itemId: simItemId }, body: { distributed: true } }, distributeRes);
  assert.equal(distributeRes.statusCode, 200, JSON.stringify(distributeRes.body));
  const simItem = distributeRes.body.data.items.find((i) => i._id.toString() === simItemId);
  assert.equal(simItem.distributed, true);
  assert.ok(simItem.distributedAt);

  const ihramItem = distributeRes.body.data.items.find((i) => i.itemName === "Ihram");
  assert.equal(ihramItem.distributed, false, "only the targeted item must change");

  // ---- Unknown item id -> 404 ----
  const badItemRes = makeRes();
  await ctrl.UpdateBookingKitItem({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString(), itemId: new mongoose.Types.ObjectId().toString() }, body: { distributed: true } }, badItemRes);
  assert.equal(badItemRes.statusCode, 404);

  // ---- GET reflects persisted state ----
  const getRes = makeRes();
  await ctrl.GetBookingKit({ auth: authAdmin(tenantId), params: { bookingId: booking._id.toString() } }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.data.items.length, 2);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
