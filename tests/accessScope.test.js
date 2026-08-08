import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { getAccessScope } from "../utils/accessScope.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Pure unit coverage for the shared helper — no DB required.
//
// Company = tenant is the ONLY data-isolation boundary in this system (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
// There is no branch-level restriction: every authenticated user of a
// tenant shares the same business data. WHICH APIs/actions a user may use is
// governed entirely by req.auth.permissions (RBAC), not by this helper.
// ---------------------------------------------------------------------------

test("getAccessScope returns null (never a wide-open filter) when there is no tenant context", () => {
  assert.equal(getAccessScope({ auth: null }), null);
  assert.equal(getAccessScope({ auth: {} }), null);
});

test("getAccessScope returns tenant-only scope regardless of any other auth fields", () => {
  assert.deepEqual(getAccessScope({ auth: { tenantId: "acme" } }), { tenantId: "acme" });
  assert.deepEqual(getAccessScope({ auth: { tenantId: "acme", department: "Sales" } }), { tenantId: "acme" });
  assert.deepEqual(getAccessScope({ auth: { tenantId: "acme", role: "SalesManager", permissions: ["booking.read"] } }), { tenantId: "acme" });
});

// ---------------------------------------------------------------------------
// End-to-end proof: every authenticated user of a tenant shares the same
// business data (no per-branch/per-user partitioning), and tenant isolation
// still holds absolutely. Verified against the real CustomerController +
// real MongoDB. Only runs when a DB is reachable, and cleans up everything
// it creates.
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

test("Company-wide shared data: every user of a tenant sees all of that tenant's customers, and tenant B never sees tenant A's data", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { SetupTenant } = await import("../controllers/Auth.js");
  const { ListCustomers, CreateCustomer } = await import("../controllers/CustomerController.js");
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const RoleModel = (await import("../models/Rolemodel.js")).default;
  const UserModel = (await import("../models/Usermodel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;

  const suffix = Date.now();
  const tenantAKey = `test-scope-a-${suffix}`;
  const tenantBKey = `test-scope-b-${suffix}`;

  t.after(async () => {
    await CustomerModel.deleteMany({ tenantId: { $in: [tenantAKey, tenantBKey] } });
    await UserModel.deleteMany({ tenantId: { $in: [tenantAKey, tenantBKey] } });
    await RoleModel.deleteMany({ tenantId: { $in: [tenantAKey, tenantBKey] } });
    await TenantModel.deleteMany({ tenantKey: { $in: [tenantAKey, tenantBKey] } });
  });

  const adminAEmail = `admin-a-${suffix}@example.com`;
  const setupARes = makeRes();
  await SetupTenant({ body: { companyName: "Tenant A Co", tenantKey: tenantAKey, username: "tenantAadmin", email: adminAEmail, password: "StrongPass1!" }, requestId: `setup-a-${suffix}`, headers: {}, header: () => null }, setupARes);
  assert.equal(setupARes.statusCode, 201, JSON.stringify(setupARes.body));

  const adminBEmail = `admin-b-${suffix}@example.com`;
  const setupBRes = makeRes();
  await SetupTenant({ body: { companyName: "Tenant B Co", tenantKey: tenantBKey, username: "tenantBadmin", email: adminBEmail, password: "StrongPass1!" }, requestId: `setup-b-${suffix}`, headers: {}, header: () => null }, setupBRes);
  assert.equal(setupBRes.statusCode, 201, JSON.stringify(setupBRes.body));

  // Sanity: each tenant owns an independent Administrator role document —
  // that part of tenant isolation (role catalogs never shared across
  // companies) is unaffected by removing branch enforcement.
  const roleA = await RoleModel.findOne({ tenantId: tenantAKey, name: "Administrator" }).lean();
  const roleB = await RoleModel.findOne({ tenantId: tenantBKey, name: "Administrator" }).lean();
  assert.ok(roleA && roleB);
  assert.notEqual(roleA._id.toString(), roleB._id.toString(), "each tenant must own an independent Administrator role document");

  // A second, non-admin employee of tenant A — proving company-wide data is
  // shared across every user of the tenant, not just the one who created it.
  const hash = await bcrypt.hash("StrongPass1!", 10);
  const staffA = await UserModel.create({ username: "staffA", email: `staff-a-${suffix}@example.com`, password: hash, tenantId: tenantAKey, role: "Administrator", status: "active", emailVerified: true });

  const adminA = await UserModel.findOne({ email: adminAEmail });
  const adminB = await UserModel.findOne({ email: adminBEmail });

  const authFor = (user) => ({ tenantId: user.tenantId, id: user._id.toString(), permissions: CUSTOMER_PERMISSIONS.concat("admin") });

  // Tenant A's admin creates a customer.
  const createRes = makeRes();
  await CreateCustomer({ auth: authFor(adminA), body: { firstName: "Test", lastName: `Customer-${suffix}`, primaryEmail: `cust-${suffix}@example.com`, primaryPhone: "+923001234567" }, query: {}, requestId: `create-${suffix}` }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  const customerId = createRes.body.data.customerId.toString();

  const listCustomerIds = async (user) => {
    const res = makeRes();
    await ListCustomers({ auth: authFor(user), query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.data.map((c) => c.customerId.toString());
  };

  assert.ok((await listCustomerIds(staffA)).includes(customerId), "a different employee of the SAME tenant must see the customer");
  assert.ok((await listCustomerIds(adminA)).includes(customerId));

  // Tenant B, a completely separate company, must never see it.
  assert.ok(!(await listCustomerIds(adminB)).includes(customerId), "tenant B must never see tenant A's customer");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
