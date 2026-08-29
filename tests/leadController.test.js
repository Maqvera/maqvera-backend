import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Controller-level coverage for Lead & Marketing Management (PRD "CRM
// Feature Map by Phase" Phase 2 module 17) — same direct-controller-call
// convention as tests/packagePricingController.test.js.

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
const authReadOnly = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: ["lead.read"] });
const authNoPerm = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: [] });

test("Lead controller: create/list/update/pipeline/convert lifecycle, permission gating, tenant scope", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/LeadController.js");
  const LeadModel = (await import("../models/LeadModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CustomerPreferenceModel = (await import("../models/CustomerPreferenceModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-lead-${suffix}`;

  t.after(async () => {
    await LeadModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
    await CustomerPreferenceModel.deleteMany({ tenantId });
    await AuditLogModel.deleteMany({ tenantId });
  });

  // ---- Permission gates ----
  const noScopeRes = makeRes();
  await ctrl.createLead({ auth: {}, body: { firstName: "X" } }, noScopeRes);
  assert.equal(noScopeRes.statusCode, 403);

  const noPermRes = makeRes();
  await ctrl.createLead({ auth: authNoPerm(tenantId), body: { firstName: "X" } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Create: invalid source rejected ----
  const badSourceRes = makeRes();
  await ctrl.createLead({ auth: authAdmin(tenantId), body: { firstName: "Bad", source: "NotARealSource" } }, badSourceRes);
  assert.equal(badSourceRes.statusCode, 400, JSON.stringify(badSourceRes.body));

  // ---- Create: happy path, defaults applied ----
  const createRes = makeRes();
  await ctrl.createLead({ auth: authAdmin(tenantId), body: { firstName: "Amina", lastName: "Khan", phone: "+92300111", source: "Website" } }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  assert.equal(createRes.body.data.status, "New", "default status must apply");
  const leadId = createRes.body.data._id.toString();

  // ---- A read-only role can list/get/pipeline but not update ----
  const listRes = makeRes();
  await ctrl.listLeads({ auth: authReadOnly(tenantId), query: {} }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.total, 1);

  const getRes = makeRes();
  await ctrl.getLead({ auth: authReadOnly(tenantId), params: { leadId } }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.data.firstName, "Amina");

  const updateNoPermRes = makeRes();
  await ctrl.updateLead({ auth: authReadOnly(tenantId), params: { leadId }, body: { status: "Contacted" } }, updateNoPermRes);
  assert.equal(updateNoPermRes.statusCode, 403);

  // ---- Update: status transition ----
  const updateRes = makeRes();
  await ctrl.updateLead({ auth: authAdmin(tenantId), params: { leadId }, body: { status: "Qualified" } }, updateRes);
  assert.equal(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.equal(updateRes.body.data.status, "Qualified");

  // ---- Pipeline: every configured status is a bucket, even empty ones ----
  const pipelineRes = makeRes();
  await ctrl.getPipeline({ auth: authReadOnly(tenantId) }, pipelineRes);
  assert.equal(pipelineRes.statusCode, 200, JSON.stringify(pipelineRes.body));
  const qualifiedBucket = pipelineRes.body.data.pipeline.find((b) => b.status === "Qualified");
  assert.equal(qualifiedBucket.count, 1);
  const newBucket = pipelineRes.body.data.pipeline.find((b) => b.status === "New");
  assert.equal(newBucket.count, 0, "an empty status must still appear as its own bucket");

  // ---- Convert: missing email must fail cleanly (CustomerModel requires it), never throw a raw 500 ----
  const convertMissingEmailRes = makeRes();
  await ctrl.convertLead({ auth: authAdmin(tenantId), params: { leadId }, body: {} }, convertMissingEmailRes);
  assert.equal(convertMissingEmailRes.statusCode, 400, JSON.stringify(convertMissingEmailRes.body));

  // ---- Convert: happy path, supplying the missing email as an override ----
  const convertRes = makeRes();
  await ctrl.convertLead({ auth: authAdmin(tenantId), params: { leadId }, body: { email: `amina.${suffix}@example.com` } }, convertRes);
  assert.equal(convertRes.statusCode, 200, JSON.stringify(convertRes.body));
  assert.equal(convertRes.body.data.status, "Converted");
  assert.ok(convertRes.body.data.convertedToCustomerId, "convertedToCustomerId must be set");

  const customer = await CustomerModel.findOne({ _id: convertRes.body.data.convertedToCustomerId, tenantId }).lean();
  assert.ok(customer, "a real CustomerModel row must have been created");
  assert.equal(customer.firstName, "Amina");
  assert.equal(customer.email, `amina.${suffix}@example.com`);

  // ---- Converting again must fail, never create a second customer ----
  const reconvertRes = makeRes();
  await ctrl.convertLead({ auth: authAdmin(tenantId), params: { leadId }, body: { email: `amina.${suffix}@example.com` } }, reconvertRes);
  assert.equal(reconvertRes.statusCode, 409, JSON.stringify(reconvertRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
