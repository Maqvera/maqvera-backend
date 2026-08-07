import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Cross-tenant isolation check for the two controllers fixed in this pass
// (VisaController.js, TravelIncidentController.js — see
// 02-tenant-isolation-audit.md §4.3): before the fix, an anonymous or
// misconfigured caller silently fell back to a client-supplied x-tenant-id
// header or the literal string "default-tenant" instead of being rejected.
// This proves the real controllers, called with real per-tenant auth
// contexts, only ever see their own tenant's visa cases / incidents.

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

const authFor = (tenantId, branchId) => ({ tenantId, branchId, id: "tester", userId: "tester", permissions: ["admin"], roleScope: "tenant" });

test("Visa case reads never cross tenant boundaries, and a missing tenant context is rejected rather than defaulted", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { getVisaCases, getVisaCaseById } = await import("../controllers/VisaController.js");
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-visa-iso-a-${suffix}`;
  const tenantB = `test-visa-iso-b-${suffix}`;

  t.after(async () => {
    await VisaCaseModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  const caseA = await VisaCaseModel.create({
    tenantId: tenantA, branchId: "MAIN", caseNumber: `VC-A-${suffix}`,
    travelerId: new mongoose.Types.ObjectId(), destinationCountry: "Testland"
  });
  await VisaCaseModel.create({
    tenantId: tenantB, branchId: "MAIN", caseNumber: `VC-B-${suffix}`,
    travelerId: new mongoose.Types.ObjectId(), destinationCountry: "Testland"
  });

  // Tenant A can list its own case, and only its own.
  const listResA = makeRes();
  await getVisaCases({ auth: authFor(tenantA, "MAIN"), query: {} }, listResA);
  assert.equal(listResA.statusCode, 200, JSON.stringify(listResA.body));
  const caseNumbersA = listResA.body.data.items.map((c) => c.caseNumber);
  assert.ok(caseNumbersA.includes(`VC-A-${suffix}`));
  assert.ok(!caseNumbersA.includes(`VC-B-${suffix}`), "tenant A must never see tenant B's visa case in the list");

  // Tenant B cannot fetch tenant A's case by ID.
  const getResB = makeRes();
  await getVisaCaseById({ auth: authFor(tenantB, "MAIN"), params: { visaCaseId: caseA._id.toString() } }, getResB);
  assert.equal(getResB.statusCode, 404, JSON.stringify(getResB.body));

  // Tenant A can fetch its own case by ID.
  const getResA = makeRes();
  await getVisaCaseById({ auth: authFor(tenantA, "MAIN"), params: { visaCaseId: caseA._id.toString() } }, getResA);
  assert.equal(getResA.statusCode, 200, JSON.stringify(getResA.body));

  // No auth context at all -> rejected, never defaulted to a fake tenant.
  const noAuthRes = makeRes();
  await getVisaCases({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

test("Incident reads never cross tenant boundaries, and a missing tenant context is rejected rather than defaulted", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { ListIncidents, GetIncidentDetails } = await import("../controllers/TravelIncidentController.js");
  const TravelIncidentManagementModel = (await import("../models/TravelIncidentManagementModel.js")).default;

  const suffix = Date.now();
  const tenantA = `test-incident-iso-a-${suffix}`;
  const tenantB = `test-incident-iso-b-${suffix}`;

  t.after(async () => {
    await TravelIncidentManagementModel.deleteMany({ tenantId: { $in: [tenantA, tenantB] } });
  });

  const incidentA = await TravelIncidentManagementModel.create({
    tenantId: tenantA, incidentNumber: `INC-A-${suffix}`, title: "Test incident A", description: "Isolation test"
  });
  await TravelIncidentManagementModel.create({
    tenantId: tenantB, incidentNumber: `INC-B-${suffix}`, title: "Test incident B", description: "Isolation test"
  });

  const listResA = makeRes();
  await ListIncidents({ auth: authFor(tenantA, "MAIN"), query: {} }, listResA);
  assert.equal(listResA.statusCode, 200, JSON.stringify(listResA.body));
  const incidentNumbersA = listResA.body.data.data.map((i) => i.incidentNumber);
  assert.ok(incidentNumbersA.includes(`INC-A-${suffix}`));
  assert.ok(!incidentNumbersA.includes(`INC-B-${suffix}`), "tenant A must never see tenant B's incident in the list");

  const getResB = makeRes();
  await GetIncidentDetails({ auth: authFor(tenantB, "MAIN"), params: { incidentId: incidentA._id.toString() } }, getResB);
  assert.equal(getResB.statusCode, 404, JSON.stringify(getResB.body));

  const getResA = makeRes();
  await GetIncidentDetails({ auth: authFor(tenantA, "MAIN"), params: { incidentId: incidentA._id.toString() } }, getResA);
  assert.equal(getResA.statusCode, 200, JSON.stringify(getResA.body));

  const noAuthRes = makeRes();
  await ListIncidents({ auth: null, query: {} }, noAuthRes);
  assert.equal(noAuthRes.statusCode, 403, JSON.stringify(noAuthRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
