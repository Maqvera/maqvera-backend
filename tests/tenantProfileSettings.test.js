import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Controller-level coverage for the tenant-wide notification/backup Settings
// endpoints (PRD "CRM Feature Map by Phase" Phase 1 module 13) — same
// direct-controller-call convention as tests/packagePricingController.test.js.

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

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });
const authNoPerm = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: [] });

test("Tenant Settings controller: defaults, partial updates, permission gating, tenant scope", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/TenantProfileController.js");
  const TenantProfileModel = (await import("../models/TenantProfileModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-tenant-settings-${suffix}`;

  t.after(async () => { await TenantProfileModel.deleteMany({ tenantId }); });

  // ---- No profile exists yet: honest defaults, never a 404/500 ----
  const defaultsRes = makeRes();
  await ctrl.GetTenantSettings({ auth: authAdmin(tenantId) }, defaultsRes);
  assert.equal(defaultsRes.statusCode, 200, JSON.stringify(defaultsRes.body));
  assert.deepEqual(defaultsRes.body.data, { notificationPreferences: { email: true, sms: true, whatsapp: true }, backupEnabled: false, backupFrequency: "Daily" });

  // ---- Permission gates ----
  const noScopeRes = makeRes();
  await ctrl.GetTenantSettings({ auth: {} }, noScopeRes);
  assert.equal(noScopeRes.statusCode, 403);

  const noPermGetRes = makeRes();
  await ctrl.GetTenantSettings({ auth: authNoPerm(tenantId) }, noPermGetRes);
  assert.equal(noPermGetRes.statusCode, 403);

  const noPermPutRes = makeRes();
  await ctrl.UpdateTenantSettings({ auth: authNoPerm(tenantId), body: { backupEnabled: true } }, noPermPutRes);
  assert.equal(noPermPutRes.statusCode, 403);

  // ---- Update creates a placeholder profile (upsert) and applies only the given fields ----
  const updateRes = makeRes();
  await ctrl.UpdateTenantSettings({ auth: authAdmin(tenantId), body: { notificationPreferences: { whatsapp: false }, backupEnabled: true, backupFrequency: "Weekly" } }, updateRes);
  assert.equal(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.equal(updateRes.body.data.notificationPreferences.whatsapp, false);
  assert.equal(updateRes.body.data.notificationPreferences.email, true, "untouched channels must keep their default");
  assert.equal(updateRes.body.data.backupEnabled, true);
  assert.equal(updateRes.body.data.backupFrequency, "Weekly");

  const profile = await TenantProfileModel.findOne({ tenantId }).lean();
  assert.ok(profile, "an upserted placeholder profile must exist");
  assert.equal(profile.companyName, "Untitled Company");

  // ---- A second partial update must not clobber the first ----
  const secondUpdateRes = makeRes();
  await ctrl.UpdateTenantSettings({ auth: authAdmin(tenantId), body: { notificationPreferences: { sms: false } } }, secondUpdateRes);
  assert.equal(secondUpdateRes.statusCode, 200, JSON.stringify(secondUpdateRes.body));
  assert.equal(secondUpdateRes.body.data.notificationPreferences.sms, false);
  assert.equal(secondUpdateRes.body.data.notificationPreferences.whatsapp, false, "the earlier whatsapp:false must survive an unrelated partial update");
  assert.equal(secondUpdateRes.body.data.backupEnabled, true, "backup settings must survive an unrelated partial update");

  // ---- GET reflects the persisted state ----
  const getRes = makeRes();
  await ctrl.GetTenantSettings({ auth: authAdmin(tenantId) }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.deepEqual(getRes.body.data, { notificationPreferences: { email: true, sms: false, whatsapp: false }, backupEnabled: true, backupFrequency: "Weekly" });
});

test("Tenant Theme controller: defaults, persistence via profile update, duplicate customDomain rejected", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/TenantProfileController.js");
  const TenantProfileModel = (await import("../models/TenantProfileModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-tenant-theme-a-${suffix}`;
  const otherTenantId = `test-tenant-theme-b-${suffix}`;

  t.after(async () => {
    await TenantProfileModel.deleteMany({ tenantId: { $in: [tenantId, otherTenantId] } });
  });

  // ---- No profile exists yet: honest defaults ----
  const defaultsRes = makeRes();
  await ctrl.GetTenantTheme({ auth: authAdmin(tenantId) }, defaultsRes);
  assert.equal(defaultsRes.statusCode, 200, JSON.stringify(defaultsRes.body));
  assert.deepEqual(defaultsRes.body.data, { companyName: null, logoUrl: null, primaryColor: null, secondaryColor: null, customDomain: null });

  // ---- Set via the profile update endpoint ----
  const domain = `agency-${suffix}.example.com`;
  const updateRes = makeRes();
  await ctrl.CreateOrUpdateTenantProfile({ auth: authAdmin(tenantId), body: { companyName: "Test Agency", primaryColor: "#112233", secondaryColor: "#445566", customDomain: domain } }, updateRes);
  assert.equal(updateRes.statusCode, 201, JSON.stringify(updateRes.body));

  const themeRes = makeRes();
  await ctrl.GetTenantTheme({ auth: authAdmin(tenantId) }, themeRes);
  assert.equal(themeRes.statusCode, 200);
  assert.equal(themeRes.body.data.primaryColor, "#112233");
  assert.equal(themeRes.body.data.secondaryColor, "#445566");
  assert.equal(themeRes.body.data.customDomain, domain);

  // ---- A second tenant claiming the same customDomain must be rejected ----
  const conflictRes = makeRes();
  await ctrl.CreateOrUpdateTenantProfile({ auth: authAdmin(otherTenantId), body: { companyName: "Other Agency", customDomain: domain } }, conflictRes);
  assert.equal(conflictRes.statusCode, 409, JSON.stringify(conflictRes.body));

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.GetTenantTheme({ auth: authNoPerm(tenantId) }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
