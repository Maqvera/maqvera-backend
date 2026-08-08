import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Company-level isolation check for UserController.js — see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md.
// Employee profiles are shared business data within a tenant: every
// authenticated user of a company sees the whole company roster. Tenant
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

const authFor = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["users.read", "employee.read"] });

test("Employee profiles are shared company-wide within a tenant, and tenant isolation remains absolute", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { ListUsers } = await import("../controllers/UserController.js");
  const EmployeeProfileModel = (await import("../models/EmployeeProfilemodel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-user-iso-a-${suffix}`;
  const tenantB = `test-user-iso-b-${suffix}`;

  t.after(async () => {
    await EmployeeProfileModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  const makeProfile = (tenantId, employeeCode) => EmployeeProfileModel.create({
    tenantId, departmentId: new mongoose.Types.ObjectId(), roleIds: [new mongoose.Types.ObjectId()],
    employeeCode, firstName: "Test", lastName: "Employee", email: `${employeeCode.toLowerCase()}@example.com`, phone: "+923001234567"
  });

  await makeProfile(tenantA, `EMP-A1-${suffix}`);
  await makeProfile(tenantA, `EMP-A2-${suffix}`);
  await makeProfile(tenantB, `EMP-B1-${suffix}`);

  const listCodes = async (tenantId) => {
    const res = makeRes();
    await ListUsers({ auth: authFor(tenantId), query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.map((u) => u.employeeCode);
  };

  // Any employee of tenant A sees the WHOLE company roster.
  assert.deepEqual((await listCodes(tenantA)).sort(), [`EMP-A1-${suffix}`, `EMP-A2-${suffix}`].sort());

  // Tenant B only ever sees its own roster.
  assert.deepEqual(await listCodes(tenantB), [`EMP-B1-${suffix}`]);

  const noAuthRes = makeRes();
  await ListUsers({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
