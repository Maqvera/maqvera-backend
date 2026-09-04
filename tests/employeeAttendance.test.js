import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Employee HR Attendance (PRD "CRM Feature Map by Phase" Phase 1 module 29)
// — deliberately distinct from models/TravelAttendanceModel.js (traveler
// check-ins, not staff clock-in/out).

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

test("Employee Attendance: clock-in/clock-out lifecycle, double-clock guards, HR read view, permission gate", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/EmployeeAttendanceController.js");
  const EmployeeProfileModel = (await import("../models/EmployeeProfilemodel.js")).default;
  const EmployeeAttendanceModel = (await import("../models/EmployeeAttendanceModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-attendance-${suffix}`;
  const identityId = new mongoose.Types.ObjectId();

  t.after(async () => {
    await EmployeeProfileModel.deleteMany({ tenantId });
    await EmployeeAttendanceModel.deleteMany({ tenantId });
  });

  const employee = await EmployeeProfileModel.create({
    tenantId, identityId, departmentId: new mongoose.Types.ObjectId(), roleIds: [new mongoose.Types.ObjectId()],
    employeeCode: `EMP-${suffix}`, firstName: "Emp", lastName: "Loyee", email: `emp.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15), status: "active"
  });

  const auth = { tenantId, id: identityId.toString(), userId: identityId.toString(), permissions: [] };

  // ---- No employee profile for a random user -> 404 ----
  const noProfileRes = makeRes();
  await ctrl.clockIn({ auth: { tenantId, id: new mongoose.Types.ObjectId().toString(), userId: "x", permissions: [] } }, noProfileRes);
  assert.equal(noProfileRes.statusCode, 404);

  // ---- Clock in ----
  const clockInRes = makeRes();
  await ctrl.clockIn({ auth }, clockInRes);
  assert.equal(clockInRes.statusCode, 200, JSON.stringify(clockInRes.body));
  assert.ok(clockInRes.body.data.clockInAt);
  assert.equal(clockInRes.body.data.clockOutAt, null);
  assert.equal(clockInRes.body.data.status, "present");

  // ---- Double clock-in must be rejected ----
  const doubleClockInRes = makeRes();
  await ctrl.clockIn({ auth }, doubleClockInRes);
  assert.equal(doubleClockInRes.statusCode, 409);

  // ---- Clock out ----
  const clockOutRes = makeRes();
  await ctrl.clockOut({ auth }, clockOutRes);
  assert.equal(clockOutRes.statusCode, 200, JSON.stringify(clockOutRes.body));
  assert.ok(clockOutRes.body.data.clockOutAt);

  // ---- Double clock-out must be rejected ----
  const doubleClockOutRes = makeRes();
  await ctrl.clockOut({ auth }, doubleClockOutRes);
  assert.equal(doubleClockOutRes.statusCode, 409);

  // ---- Clocking out without a prior clock-in (different employee) must fail cleanly ----
  const otherIdentity = new mongoose.Types.ObjectId();
  await EmployeeProfileModel.create({
    tenantId, identityId: otherIdentity, departmentId: new mongoose.Types.ObjectId(), roleIds: [new mongoose.Types.ObjectId()],
    employeeCode: `EMP-B-${suffix}`, firstName: "Other", lastName: "Person", email: `other.${suffix}@example.com`, phone: `+92301${suffix}`.slice(0, 15), status: "active"
  });
  const noClockInYetRes = makeRes();
  await ctrl.clockOut({ auth: { tenantId, id: otherIdentity.toString(), userId: otherIdentity.toString(), permissions: [] } }, noClockInYetRes);
  assert.equal(noClockInYetRes.statusCode, 400);

  // ---- HR read view: permission gate + real records ----
  const noPermReadRes = makeRes();
  await ctrl.getAttendance({ auth: { tenantId, id: "hr", userId: "hr", permissions: [] }, params: { employeeId: employee._id.toString() }, query: {} }, noPermReadRes);
  assert.equal(noPermReadRes.statusCode, 403);

  const readRes = makeRes();
  await ctrl.getAttendance({ auth: { tenantId, id: "hr", userId: "hr", permissions: ["employee.read"] }, params: { employeeId: employee._id.toString() }, query: {} }, readRes);
  assert.equal(readRes.statusCode, 200, JSON.stringify(readRes.body));
  assert.equal(readRes.body.data.items.length, 1);
  assert.ok(readRes.body.data.items[0].clockInAt);
  assert.ok(readRes.body.data.items[0].clockOutAt);

  // ---- Invalid month format rejected ----
  const badMonthRes = makeRes();
  await ctrl.getAttendance({ auth: { tenantId, id: "hr", userId: "hr", permissions: ["employee.read"] }, params: { employeeId: employee._id.toString() }, query: { month: "not-a-month" } }, badMonthRes);
  assert.equal(badMonthRes.statusCode, 400);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
