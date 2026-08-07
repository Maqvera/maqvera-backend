import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { getAccessScope, applyOptionalBranchFilter } from "../utils/accessScope.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Pure unit coverage for the shared helper — no DB required.
// ---------------------------------------------------------------------------

test("getAccessScope returns null (never a wide-open filter) when there is no tenant context", () => {
  assert.equal(getAccessScope({ auth: null }), null);
  assert.equal(getAccessScope({ auth: {} }), null);
});

test("getAccessScope restricts a branch-scoped role to its own tenant + branch", () => {
  const scope = getAccessScope({ auth: { tenantId: "acme", branchId: "KARACHI", roleScope: "branch" } });
  assert.deepEqual(scope, { tenantId: "acme", branchId: "KARACHI" });
});

test("getAccessScope grants a tenant-scoped role every branch within its own tenant only", () => {
  const scope = getAccessScope({ auth: { tenantId: "acme", branchId: "KARACHI", roleScope: "tenant" } });
  assert.deepEqual(scope, { tenantId: "acme" });
});

test("getAccessScope defaults to branch-restricted when roleScope is missing/unknown (fail-safe)", () => {
  const scope = getAccessScope({ auth: { tenantId: "acme", branchId: "KARACHI" } });
  assert.deepEqual(scope, { tenantId: "acme", branchId: "KARACHI" });
});

test("applyOptionalBranchFilter lets a tenant-scoped caller narrow to a branch via query param", () => {
  const scope = { tenantId: "acme" };
  assert.deepEqual(applyOptionalBranchFilter(scope, "LAHORE"), { tenantId: "acme", branchId: "LAHORE" });
});

test("applyOptionalBranchFilter cannot widen a branch-locked caller onto a different branch", () => {
  const scope = { tenantId: "acme", branchId: "KARACHI" };
  assert.deepEqual(applyOptionalBranchFilter(scope, "LAHORE"), { tenantId: "acme", branchId: "KARACHI" });
});

// ---------------------------------------------------------------------------
// End-to-end isolation matrix: (tenant A/branch1, tenant A/branch2,
// tenant B/branch1) x (branch-role, tenant-role), verified against the real
// CustomerController + real MongoDB. Only runs when a DB is reachable, and
// cleans up everything it creates — same pattern as tests/authSetup.test.js.
// ---------------------------------------------------------------------------

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

const CUSTOMER_PERMISSIONS = ["customer.read", "customer.create", "customers.read", "customers.create"];

test("Branch vs. tenant role scope: exact visibility matrix across (tenant A/branch1, tenant A/branch2, tenant B/branch1) x (branch-role, tenant-role)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { SetupTenant } = await import("../controllers/Auth.js");
  const { ListCustomers, CreateCustomer } = await import("../controllers/CustomerController.js");
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const BranchModel = (await import("../models/Branchmodel.js")).default;
  const RoleModel = (await import("../models/Rolemodel.js")).default;
  const UserModel = (await import("../models/Usermodel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;

  const suffix = Date.now();
  const tenantAKey = `test-scope-a-${suffix}`;
  const tenantBKey = `test-scope-b-${suffix}`;
  const branch1Key = "MAIN";
  const branch2Key = "BRANCH2";

  t.after(async () => {
    await CustomerModel.deleteMany({ tenantId: { $in: [tenantAKey, tenantBKey] } });
    await UserModel.deleteMany({ tenantId: { $in: [tenantAKey, tenantBKey] } });
    await RoleModel.deleteMany({ tenantId: { $in: [tenantAKey, tenantBKey] } });
    await BranchModel.deleteMany({ tenantKey: { $in: [tenantAKey, tenantBKey] } });
    await TenantModel.deleteMany({ tenantKey: { $in: [tenantAKey, tenantBKey] } });
  });

  // --- Provision tenant A (with a second branch) and tenant B via the real setup endpoint ---
  const adminAEmail = `admin-a-${suffix}@example.com`;
  const setupARes = makeRes();
  await SetupTenant({ body: { companyName: "Tenant A Co", tenantKey: tenantAKey, username: "tenantAadmin", email: adminAEmail, password: "StrongPass1!" }, requestId: `setup-a-${suffix}`, headers: {}, header: () => null }, setupARes);
  assert.equal(setupARes.statusCode, 201, JSON.stringify(setupARes.body));

  const adminBEmail = `admin-b-${suffix}@example.com`;
  const setupBRes = makeRes();
  await SetupTenant({ body: { companyName: "Tenant B Co", tenantKey: tenantBKey, username: "tenantBadmin", email: adminBEmail, password: "StrongPass1!" }, requestId: `setup-b-${suffix}`, headers: {}, header: () => null }, setupBRes);
  assert.equal(setupBRes.statusCode, 201, JSON.stringify(setupBRes.body));

  await BranchModel.create({ branchKey: branch2Key, tenantKey: tenantAKey, name: "Second Branch", status: "active" });

  // Sanity: the tenant-wide Administrator role SetupTenant creates must be
  // its own tenant-scoped document with scope "tenant" — not a shared/global row.
  const roleA = await RoleModel.findOne({ tenantId: tenantAKey, name: "Administrator" }).lean();
  const roleB = await RoleModel.findOne({ tenantId: tenantBKey, name: "Administrator" }).lean();
  assert.ok(roleA && roleA.scope === "tenant");
  assert.ok(roleB && roleB.scope === "tenant");
  assert.notEqual(roleA._id.toString(), roleB._id.toString(), "each tenant must own an independent Administrator role document");

  // --- Branch-scoped roles, one per tenant (role names are unique per tenant, not globally) ---
  await RoleModel.create({ tenantId: tenantAKey, name: "BranchStaff", permissions: CUSTOMER_PERMISSIONS, scope: "branch", status: "active" });
  await RoleModel.create({ tenantId: tenantBKey, name: "BranchStaff", permissions: CUSTOMER_PERMISSIONS, scope: "branch", status: "active" });

  // --- Branch-scoped identities (created directly — no invite/role-assignment API exists yet) ---
  const hash = await bcrypt.hash("StrongPass1!", 10);
  const brancherA1 = await UserModel.create({ username: "brancherA1", email: `brancher-a1-${suffix}@example.com`, password: hash, tenantId: tenantAKey, branchId: branch1Key, role: "BranchStaff", status: "active", emailVerified: true });
  const brancherA2 = await UserModel.create({ username: "brancherA2", email: `brancher-a2-${suffix}@example.com`, password: hash, tenantId: tenantAKey, branchId: branch2Key, role: "BranchStaff", status: "active", emailVerified: true });
  const brancherB1 = await UserModel.create({ username: "brancherB1", email: `brancher-b1-${suffix}@example.com`, password: hash, tenantId: tenantBKey, branchId: branch1Key, role: "BranchStaff", status: "active", emailVerified: true });

  const adminA = await UserModel.findOne({ email: adminAEmail });
  const adminB = await UserModel.findOne({ email: adminBEmail });

  const authFor = (user, roleScope) => ({ tenantId: user.tenantId, branchId: user.branchId, id: user._id.toString(), permissions: roleScope === "tenant" ? CUSTOMER_PERMISSIONS.concat("admin") : CUSTOMER_PERMISSIONS, roleScope });

  // --- Write-side: each branch-scoped user creates "their" customer in their own branch ---
  // Distinct phone/lastName per customer: duplicate-detection is tenant-wide
  // (see detectDuplicateCustomer), so two same-tenant customers sharing an
  // identifier would otherwise trip a false-positive 409 here.
  let phoneCounter = 0;
  const createCustomer = async (user, roleScope, extraBody = {}) => {
    phoneCounter += 1;
    const req = { auth: authFor(user, roleScope), body: { firstName: "Test", lastName: `Customer${phoneCounter}-${suffix}`, primaryEmail: `cust-${Math.random().toString(36).slice(2)}-${suffix}@example.com`, primaryPhone: `+9230012${String(suffix).slice(-3)}${phoneCounter}`, ...extraBody }, query: {}, requestId: `create-${suffix}-${Math.random()}` };
    const res = makeRes();
    await CreateCustomer(req, res);
    return res;
  };

  const custA1Res = await createCustomer(brancherA1, "branch");
  assert.equal(custA1Res.statusCode, 201, JSON.stringify(custA1Res.body));
  const custA2Res = await createCustomer(brancherA2, "branch");
  assert.equal(custA2Res.statusCode, 201, JSON.stringify(custA2Res.body));
  const custB1Res = await createCustomer(brancherB1, "branch");
  assert.equal(custB1Res.statusCode, 201, JSON.stringify(custB1Res.body));

  const custA1Id = custA1Res.body.data.customerId.toString();
  const custA2Id = custA2Res.body.data.customerId.toString();
  const custB1Id = custB1Res.body.data.customerId.toString();

  // Write-side branch enforcement: a branch-scoped user cannot create a
  // customer in a DIFFERENT branch of their own tenant by naming it in the body.
  const crossBranchAttempt = await createCustomer(brancherA1, "branch", { branchId: branch2Key });
  assert.equal(crossBranchAttempt.statusCode, 403, JSON.stringify(crossBranchAttempt.body));
  const branch2CountAfterAttempt = await CustomerModel.countDocuments({ tenantId: tenantAKey, branchId: branch2Key });
  assert.equal(branch2CountAfterAttempt, 1, "the rejected cross-branch create must not have persisted a second customer under branch2");

  // --- Read-side: exact visibility matrix ---
  const listCustomerIds = async (user, roleScope) => {
    const req = { auth: authFor(user, roleScope), query: {} };
    const res = makeRes();
    await ListCustomers(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.map((c) => c.customerId.toString()).sort();
  };

  const visibleToA1 = await listCustomerIds(brancherA1, "branch");
  assert.deepEqual(visibleToA1, [custA1Id], "tenant A / branch1 (branch-role) must see only its own branch's customer");

  const visibleToA2 = await listCustomerIds(brancherA2, "branch");
  assert.deepEqual(visibleToA2, [custA2Id], "tenant A / branch2 (branch-role) must see only its own branch's customer");

  const visibleToB1 = await listCustomerIds(brancherB1, "branch");
  assert.deepEqual(visibleToB1, [custB1Id], "tenant B / branch1 (branch-role) must see only its own branch's customer");

  const visibleToAdminA = await listCustomerIds(adminA, "tenant");
  assert.deepEqual(visibleToAdminA.sort(), [custA1Id, custA2Id].sort(), "tenant A admin (tenant-role) must see every branch within tenant A, and nothing from tenant B");

  const visibleToAdminAFromBranch2Token = await listCustomerIds({ ...adminA.toObject(), branchId: branch2Key }, "tenant");
  assert.deepEqual(visibleToAdminAFromBranch2Token.sort(), [custA1Id, custA2Id].sort(), "tenant-scoped access must not depend on which branch happens to be on the caller's own token");

  const visibleToAdminB = await listCustomerIds(adminB, "tenant");
  assert.deepEqual(visibleToAdminB, [custB1Id], "tenant B admin (tenant-role) must see tenant B's customer only — never tenant A's");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
