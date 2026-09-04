import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Staff-facing daily task checklist (PRD "CRM Feature Map by Phase" Phase 1
// module 29) — GET /bookings/my-tasks. BookingTaskModel already existed;
// this is the one missing cross-booking read view.

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

const authFor = (tenantId, userId) => ({ tenantId, id: userId, userId, permissions: ["booking.read"] });

test("GetMyTasks: cross-booking, assigned-to-me, grouped by due date, own-user-only isolation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { GetMyTasks } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingTaskModel = (await import("../models/BookingTaskModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-mytasks-${suffix}`;
  const userA = `staff-a-${suffix}`;
  const userB = `staff-b-${suffix}`;

  t.after(async () => {
    await Promise.all([
      BookingHeaderModel.deleteMany({ tenantId }),
      BookingTaskModel.deleteMany({ tenantId }),
      CustomerModel.deleteMany({ tenantId })
    ]);
  });

  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "T", lastName: "T", email: `t.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });
  const booking = await BookingHeaderModel.create({ tenantId, bookingReference: `BK-${suffix}`, customerId: customer._id, totalAmount: 100, currency: "USD" });

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 3, 0, 0));
  const tomorrowUtc = new Date(todayUtc.getTime() + 86400000);

  await BookingTaskModel.create({ tenantId, bookingId: booking._id, title: "Call customer", assignedTo: userA, dueDate: todayUtc, workflowStatus: "assigned" });
  await BookingTaskModel.create({ tenantId, bookingId: booking._id, title: "Follow up tomorrow", assignedTo: userA, dueDate: tomorrowUtc, workflowStatus: "assigned" });
  await BookingTaskModel.create({ tenantId, bookingId: booking._id, title: "Old completed task", assignedTo: userA, dueDate: todayUtc, workflowStatus: "completed" });
  await BookingTaskModel.create({ tenantId, bookingId: booking._id, title: "Someone else's task", assignedTo: userB, dueDate: todayUtc, workflowStatus: "assigned" });

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await GetMyTasks({ auth: { tenantId, id: userA, userId: userA, permissions: [] }, query: {} }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Default view: own pending tasks only, completed excluded ----
  const defaultRes = makeRes();
  await GetMyTasks({ auth: authFor(tenantId, userA), query: {} }, defaultRes);
  assert.equal(defaultRes.statusCode, 200, JSON.stringify(defaultRes.body));
  assert.equal(defaultRes.body.data.total, 2, "completed task and userB's task must both be excluded by default");
  const titles = defaultRes.body.data.grouped.flatMap((g) => g.items.map((i) => i.title));
  assert.ok(titles.includes("Call customer"));
  assert.ok(titles.includes("Follow up tomorrow"));
  assert.ok(!titles.includes("Old completed task"));
  assert.ok(!titles.includes("Someone else's task"));

  // ---- date=today filters to just today's bucket ----
  const todayRes = makeRes();
  await GetMyTasks({ auth: authFor(tenantId, userA), query: { date: "today" } }, todayRes);
  assert.equal(todayRes.statusCode, 200);
  assert.equal(todayRes.body.data.total, 1);
  assert.equal(todayRes.body.data.grouped.length, 1);
  assert.equal(todayRes.body.data.grouped[0].items[0].title, "Call customer");

  // ---- includeCompleted=true surfaces the completed task too ----
  const withCompletedRes = makeRes();
  await GetMyTasks({ auth: authFor(tenantId, userA), query: { includeCompleted: "true" } }, withCompletedRes);
  assert.equal(withCompletedRes.statusCode, 200);
  assert.equal(withCompletedRes.body.data.total, 3);

  // ---- User isolation: userB sees only their own task ----
  const userBRes = makeRes();
  await GetMyTasks({ auth: authFor(tenantId, userB), query: {} }, userBRes);
  assert.equal(userBRes.statusCode, 200);
  assert.equal(userBRes.body.data.total, 1);
  assert.equal(userBRes.body.data.grouped[0].items[0].title, "Someone else's task");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
