import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Verifies the admin-configurable RBAC surface required by the Final
// Architecture spec (docs/06-external-integrations/03-final-architecture-no-branches-rbac.md
// requirement #5, "Admin-Controlled Permissions"): a company admin can
// define custom roles with a specific, real permission set, edit that set
// later, and the system rejects unknown permission keys, cross-tenant
// access, and deletion of roles still in use.

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

const authFor = (tenantId) => ({ tenantId, id: "tester", permissions: ["admin"] });

test("Company admin can define, edit, and delete custom roles with a real, validated permission set — scoped to their own company", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { CreateRole, UpdateRole, DeleteRole, ListRoles, GetRole, ListPermissions } = await import("../controllers/RoleController.js");
  const RoleModel = (await import("../models/Rolemodel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-role-a-${suffix}`;
  const tenantB = `test-role-b-${suffix}`;

  t.after(async () => {
    await RoleModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  // The permission catalog is real, seeded reference data.
  const catalogRes = makeRes();
  await ListPermissions({ auth: authFor(tenantA), requestId: `perm-${suffix}` }, catalogRes);
  assert.equal(catalogRes.statusCode, 200, JSON.stringify(catalogRes.body));
  assert.ok(catalogRes.body.data.permissions.some((p) => p.key === "customer.read"));
  assert.ok(catalogRes.body.data.byModule.customer, "catalog must be groupable by module (e.g. 'customer')");

  // Unknown permission keys are rejected, not silently accepted.
  const badRes = makeRes();
  await CreateRole({ auth: authFor(tenantA), body: { name: "Sales Manager", permissions: ["not-a-real-permission"] }, requestId: `create-bad-${suffix}` }, badRes);
  assert.equal(badRes.statusCode, 422, JSON.stringify(badRes.body));

  // A real custom role, scoped to tenant A only.
  const createRes = makeRes();
  await CreateRole({ auth: authFor(tenantA), body: { name: "Sales Manager", description: "Handles sales pipeline", permissions: ["customer.read", "booking.read", "booking.create"] }, requestId: `create-${suffix}` }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  const roleId = createRes.body.data._id.toString();

  // Duplicate name within the same tenant is rejected.
  const dupRes = makeRes();
  await CreateRole({ auth: authFor(tenantA), body: { name: "Sales Manager", permissions: ["customer.read"] }, requestId: `create-dup-${suffix}` }, dupRes);
  assert.equal(dupRes.statusCode, 409, JSON.stringify(dupRes.body));

  // Tenant B cannot see or fetch tenant A's role.
  const listBRes = makeRes();
  await ListRoles({ auth: authFor(tenantB), requestId: `list-b-${suffix}` }, listBRes);
  assert.equal(listBRes.statusCode, 200, JSON.stringify(listBRes.body));
  assert.ok(!listBRes.body.data.some((r) => r._id.toString() === roleId), "tenant B must never see tenant A's role");

  const getFromBRes = makeRes();
  await GetRole({ auth: authFor(tenantB), params: { roleId }, requestId: `get-b-${suffix}` }, getFromBRes);
  assert.equal(getFromBRes.statusCode, 404, JSON.stringify(getFromBRes.body));

  // The admin narrows the role's permissions.
  const updateRes = makeRes();
  await UpdateRole({ auth: authFor(tenantA), params: { roleId }, body: { permissions: ["customer.read"] }, requestId: `update-${suffix}` }, updateRes);
  assert.equal(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.deepEqual(updateRes.body.data.permissions, ["customer.read"]);

  // The role can be deleted once unused.
  const deleteRes = makeRes();
  await DeleteRole({ auth: authFor(tenantA), params: { roleId }, requestId: `delete-${suffix}` }, deleteRes);
  assert.equal(deleteRes.statusCode, 200, JSON.stringify(deleteRes.body));

  const confirmGoneRes = makeRes();
  await GetRole({ auth: authFor(tenantA), params: { roleId }, requestId: `get-gone-${suffix}` }, confirmGoneRes);
  assert.equal(confirmGoneRes.statusCode, 404, JSON.stringify(confirmGoneRes.body));
});

test("The seeded system Administrator role cannot be deleted", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { SetupTenant } = await import("../controllers/Auth.js");
  const { DeleteRole } = await import("../controllers/RoleController.js");
  const RoleModel = (await import("../models/Rolemodel.js")).default;
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const UserModel = (await import("../models/Usermodel.js")).default;

  const suffix = Date.now();
  const tenantKey = `test-role-sys-${suffix}`;
  const email = `sys-role-${suffix}@example.com`;

  t.after(async () => {
    await UserModel.deleteMany({ email });
    await RoleModel.deleteMany({ tenantId: tenantKey });
    await TenantModel.deleteMany({ tenantKey });
  });

  const setupRes = makeRes();
  await SetupTenant({ body: { companyName: "Sys Role Co", tenantKey, username: "sysroleadmin", email, password: "StrongPass1!" }, requestId: `setup-${suffix}`, headers: {}, header: () => null }, setupRes);
  assert.equal(setupRes.statusCode, 201, JSON.stringify(setupRes.body));

  const adminRole = await RoleModel.findOne({ tenantId: tenantKey, name: "Administrator" }).lean();
  assert.ok(adminRole && adminRole.isSystemRole);

  const deleteRes = makeRes();
  await DeleteRole({ auth: authFor(tenantKey), params: { roleId: adminRole._id.toString() }, requestId: `delete-sys-${suffix}` }, deleteRes);
  assert.equal(deleteRes.statusCode, 403, JSON.stringify(deleteRes.body));

  const stillThere = await RoleModel.findById(adminRole._id).lean();
  assert.ok(stillThere, "the system Administrator role must still exist");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
