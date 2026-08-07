import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Cross-tenant + cross-branch isolation check for UserController.js after
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

const authFor = (tenantId, branchId, roleScope) => ({ tenantId, branchId, id: "tester", userId: "tester", permissions: ["users.read", "employee.read"], roleScope });

test("Employee profiles are isolated by tenant AND by branch (branch-scoped roles), tenant-wide for tenant-scoped roles", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { ListUsers } = await import("../controllers/UserController.js");
  const EmployeeProfileModel = (await import("../models/EmployeeProfilemodel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-user-iso-a-${suffix}`;
  const tenantB = `test-user-iso-b-${suffix}`;
  const branch1 = "BR1";
  const branch2 = "BR2";

  t.after(async () => {
    await EmployeeProfileModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  const makeProfile = (tenantId, branchId, employeeCode) => EmployeeProfileModel.create({
    tenantId, branchId, departmentId: new mongoose.Types.ObjectId(), roleIds: [new mongoose.Types.ObjectId()],
    employeeCode, firstName: "Test", lastName: "Employee", email: `${employeeCode.toLowerCase()}@example.com`, phone: "+923001234567"
  });

  await makeProfile(tenantA, branch1, `EMP-A1-${suffix}`);
  await makeProfile(tenantA, branch2, `EMP-A2-${suffix}`);
  await makeProfile(tenantB, branch1, `EMP-B1-${suffix}`);

  const listCodes = async (tenantId, branchId, roleScope) => {
    const res = makeRes();
    await ListUsers({ auth: authFor(tenantId, branchId, roleScope), query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.map((u) => u.employeeCode);
  };

  assert.deepEqual(await listCodes(tenantA, branch1, "branch"), [`EMP-A1-${suffix}`]);
  assert.deepEqual(await listCodes(tenantA, branch2, "branch"), [`EMP-A2-${suffix}`]);
  assert.deepEqual(await listCodes(tenantB, branch1, "branch"), [`EMP-B1-${suffix}`]);

  const tenantAAll = await listCodes(tenantA, branch1, "tenant");
  assert.deepEqual(tenantAAll.sort(), [`EMP-A1-${suffix}`, `EMP-A2-${suffix}`].sort());

  const noAuthRes = makeRes();
  await ListUsers({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
