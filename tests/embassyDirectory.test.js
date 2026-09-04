import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Embassy/consulate contact directory (PRD "CRM Feature Map by Phase"
// Phase 4 module 40 — Emergency Support), extending the existing
// EmbassyMasterModel (visa-submission routing) with contact fields.

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
const authReadOnly = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: ["reference.read"] });

test("Embassy Directory: create/update/list, duplicate embassyId rejected, permission gate, tenant scope", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/EmbassyDirectoryController.js");
  const EmbassyMasterModel = (await import("../models/EmbassyMasterModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-embassy-${suffix}`;
  t.after(async () => { await EmbassyMasterModel.deleteMany({ tenantId }); });

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.createEmbassyContact({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, body: { embassyId: `EMB-${suffix}`, name: "X", processingCenterType: "Embassy", countryId: "SA" } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Read-only role cannot create ----
  const readOnlyCreateRes = makeRes();
  await ctrl.createEmbassyContact({ auth: authReadOnly(tenantId), body: { embassyId: `EMB-${suffix}`, name: "X", processingCenterType: "Embassy", countryId: "SA" } }, readOnlyCreateRes);
  assert.equal(readOnlyCreateRes.statusCode, 403);

  // ---- Create ----
  const embassyId = `EMB-${suffix}`;
  const createRes = makeRes();
  await ctrl.createEmbassyContact({
    auth: authAdmin(tenantId),
    body: { embassyId, name: "Saudi Embassy", processingCenterType: "Embassy", countryId: "SA", city: "Islamabad", phone: "+92-51-1234567", emergencyContactPhone: "+92-300-0000000" }
  }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  assert.equal(createRes.body.data.emergencyContactPhone, "+92-300-0000000");
  const recordId = createRes.body.data._id.toString();

  // ---- Duplicate embassyId rejected ----
  const dupRes = makeRes();
  await ctrl.createEmbassyContact({ auth: authAdmin(tenantId), body: { embassyId, name: "Dup", processingCenterType: "Embassy", countryId: "SA" } }, dupRes);
  assert.equal(dupRes.statusCode, 409);

  // ---- List, filter by countryId ----
  const listRes = makeRes();
  await ctrl.listEmbassyContacts({ auth: authReadOnly(tenantId), query: { countryId: "SA" } }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 1);
  assert.equal(listRes.body.data.items[0].city, "Islamabad");

  // ---- Update contact fields ----
  const updateRes = makeRes();
  await ctrl.updateEmbassyContact({ auth: authAdmin(tenantId), params: { embassyId: recordId }, body: { phone: "+92-51-9999999", isActive: false } }, updateRes);
  assert.equal(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.equal(updateRes.body.data.phone, "+92-51-9999999");
  assert.equal(updateRes.body.data.isActive, false);
  assert.equal(updateRes.body.data.city, "Islamabad", "an untouched field must survive a partial update");

  // ---- Unknown record -> 404 ----
  const notFoundRes = makeRes();
  await ctrl.updateEmbassyContact({ auth: authAdmin(tenantId), params: { embassyId: new mongoose.Types.ObjectId().toString() }, body: { phone: "x" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
