import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { authSchemas } from "../middleware/validateRequest.js";
import { DEFAULT_PERMISSIONS, ADMINISTRATOR_ROLE_NAME } from "../utils/authDomainDefaults.js";

// node --test runs each file in its own process, so process.env is not
// inherited from any other test file's dotenv.config() call — load it here
// too, the same way utils/authConfig.js does, or the URI-availability check
// below would always see an empty environment and skip the live tests.
dotenv.config();

// ---------------------------------------------------------------------------
// Schema-level validation — no DB required, mirrors the existing
// userValidation.test.js convention of exercising Joi schemas directly.
// ---------------------------------------------------------------------------

const validPayload = {
  companyName: "Acme Travels",
  tenantKey: "acme-travels",
  username: "acmeadmin",
  email: "admin@acme-test.example.com",
  password: "StrongPass1!",
};

test("authSchemas.setupTenant accepts a complete, valid payload", () => {
  const result = authSchemas.setupTenant.validate(validPayload);
  assert.equal(result.error, undefined);
  assert.equal(result.value.tenantKey, "acme-travels");
});

test("authSchemas.setupTenant rejects missing required fields", () => {
  const result = authSchemas.setupTenant.validate({ companyName: "Acme Travels" }, { abortEarly: false });
  assert.ok(result.error);
  assert.match(result.error.message, /tenantKey/);
  assert.match(result.error.message, /username/);
  assert.match(result.error.message, /email/);
  assert.match(result.error.message, /password/);
});

test("authSchemas.setupTenant rejects a password shorter than policy allows", () => {
  const result = authSchemas.setupTenant.validate({ ...validPayload, password: "abc" });
  assert.ok(result.error);
  assert.match(result.error.message, /password/i);
});

test("authSchemas.setupTenant rejects a tenantKey that is not a lowercase slug", () => {
  const result = authSchemas.setupTenant.validate({ ...validPayload, tenantKey: "Acme Travels Inc!" });
  assert.ok(result.error);
  assert.match(result.error.message, /tenantKey/);
});

test("authSchemas.signup leaves tenantKey optional but still validates its format when supplied", () => {
  const withoutTenant = authSchemas.signup.validate({ username: "jane", email: "jane@example.com", password: "StrongPass1!" });
  assert.equal(withoutTenant.error, undefined);

  const withBadTenant = authSchemas.signup.validate({ username: "jane", email: "jane@example.com", password: "StrongPass1!", tenantKey: "NOT A SLUG" });
  assert.ok(withBadTenant.error);
  assert.match(withBadTenant.error.message, /tenantKey/);
});

test("authDomainDefaults exposes a real, non-empty, deduplicated permission set backing the Administrator role", () => {
  assert.ok(Array.isArray(DEFAULT_PERMISSIONS) && DEFAULT_PERMISSIONS.length > 0);
  const keys = DEFAULT_PERMISSIONS.map((permission) => permission.key);
  assert.equal(new Set(keys).size, keys.length, "permission keys must be unique");
  assert.equal(ADMINISTRATOR_ROLE_NAME, "Administrator");
});

// ---------------------------------------------------------------------------
// End-to-end DB-backed behavior — only runs against a real MongoDB, matching
// CLAUDE.md's own note that "few [tests] need a live MongoDB connection".
// Skips cleanly (not a failure) when no DB is configured/reachable, and
// cleans up every document it creates so it never pollutes a real database.
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

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("SetupTenant creates a real tenant, branch, Administrator role, and admin user end-to-end", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { SetupTenant } = await import("../controllers/Auth.js");
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const BranchModel = (await import("../models/Branchmodel.js")).default;
  const UserModel = (await import("../models/Usermodel.js")).default;

  const suffix = Date.now();
  const tenantKey = `test-setup-${suffix}`;
  const email = `test-setup-${suffix}@example.com`;

  t.after(async () => {
    await UserModel.deleteMany({ email });
    await BranchModel.deleteMany({ tenantKey });
    await TenantModel.deleteMany({ tenantKey });
  });

  const req = { body: { companyName: "Test Setup Co", tenantKey, username: "testsetupadmin", email, password: "StrongPass1!" }, requestId: `req-${suffix}`, headers: {}, header: () => null };
  const res = makeRes();

  await SetupTenant(req, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.tenantId, tenantKey);

  const tenant = await TenantModel.findOne({ tenantKey });
  assert.ok(tenant, "tenant document must be persisted");
  assert.equal(tenant.status, "active");

  const branch = await BranchModel.findOne({ tenantKey, branchKey: "MAIN" });
  assert.ok(branch, "branch document must be persisted");

  const user = await UserModel.findOne({ email });
  assert.ok(user, "user document must be persisted");
  assert.equal(user.tenantId, tenantKey);
  assert.equal(user.branchId, "MAIN");
  assert.equal(user.role, "Administrator");
});

test("SetupTenant rejects a duplicate tenantKey", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { SetupTenant } = await import("../controllers/Auth.js");
  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const BranchModel = (await import("../models/Branchmodel.js")).default;
  const UserModel = (await import("../models/Usermodel.js")).default;

  const suffix = Date.now();
  const tenantKey = `test-dup-${suffix}`;
  const firstEmail = `test-dup-first-${suffix}@example.com`;
  const secondEmail = `test-dup-second-${suffix}@example.com`;

  t.after(async () => {
    await UserModel.deleteMany({ email: { $in: [firstEmail, secondEmail] } });
    await BranchModel.deleteMany({ tenantKey });
    await TenantModel.deleteMany({ tenantKey });
  });

  const firstReq = { body: { companyName: "Dup Co", tenantKey, username: "dupadmin1", email: firstEmail, password: "StrongPass1!" }, requestId: `req-dup-1-${suffix}`, headers: {}, header: () => null };
  const firstRes = makeRes();
  await SetupTenant(firstReq, firstRes);
  assert.equal(firstRes.statusCode, 201, JSON.stringify(firstRes.body));

  const secondReq = { body: { companyName: "Dup Co Again", tenantKey, username: "dupadmin2", email: secondEmail, password: "StrongPass1!" }, requestId: `req-dup-2-${suffix}`, headers: {}, header: () => null };
  const secondRes = makeRes();
  await SetupTenant(secondReq, secondRes);

  assert.equal(secondRes.statusCode, 409, JSON.stringify(secondRes.body));
  assert.equal(secondRes.body.success, false);

  const usersForTenant = await UserModel.countDocuments({ tenantId: tenantKey });
  assert.equal(usersForTenant, 1, "the rejected duplicate must not have created a second user under the same tenant");
});

test("Signup rejects a request with no resolvable tenant (no tenantKey, no DEFAULT_TENANT_KEY)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const originalDefault = process.env.DEFAULT_TENANT_KEY;
  delete process.env.DEFAULT_TENANT_KEY;
  t.after(() => {
    if (originalDefault !== undefined) process.env.DEFAULT_TENANT_KEY = originalDefault;
  });

  const { Signup } = await import("../controllers/Auth.js");
  const UserModel = (await import("../models/Usermodel.js")).default;

  const suffix = Date.now();
  const email = `test-notenant-${suffix}@example.com`;
  t.after(async () => {
    await UserModel.deleteMany({ email });
  });

  const req = { body: { username: "notenantuser", email, password: "StrongPass1!" }, requestId: `req-notenant-${suffix}`, headers: {}, header: () => null };
  const res = makeRes();
  await Signup(req, res);

  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.equal(res.body.success, false);

  const created = await UserModel.findOne({ email });
  assert.equal(created, null, "no user may ever be created without an explicit, resolvable tenant");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
