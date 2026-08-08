import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Regression test for a real bug found on re-verifying the "no branch
// isolation" architecture (docs/06-external-integrations/03-final-architecture-no-branches-rbac.md):
// controllers/VisaController.js's resolveWriteBranchId() defaulted to the
// literal string "main" when a write endpoint didn't get an explicit
// branchId, and that value silently leaked into several services'
// *existence-lookup* filters for the visa case a sub-resource write targets
// (e.g. VisaService.getVisaCaseById's `if (branchId) filter.branchId = ...`,
// and PassportTrackingEngineService.receivePassport's unconditional filter).
// The practical effect: any real visa case whose branchId wasn't literally
// "main" made addVisaCaseNote/getVisaCaseTimeline/getVisaCaseAIContext/
// uploadVisaCaseDocument/receivePassport/etc. fail with "not found", even
// though the caller had full tenant access and the right permission — a
// silent violation of "Shared Business Data Within a Company." Fixed by
// defaulting resolveWriteBranchId to null instead of "main".

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

const authFor = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });

test("Visa case sub-resource writes/reads succeed regardless of the case's own branchId (no branch isolation)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { addVisaCaseNote, getVisaCaseTimeline, getVisaCaseAIContext } = await import("../controllers/VisaController.js");
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const TimelinePolicyModel = (await import("../models/TimelinePolicyModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-visa-branch-agnostic-${suffix}`;

  t.after(async () => {
    await VisaCaseModel.deleteMany({ tenantId });
    await TimelinePolicyModel.deleteMany({ tenantId });
  });

  await TimelinePolicyModel.create({
    tenantId, noteTypes: ["Internal"], visibilityLevels: ["Internal"], maxNoteLength: 5000, isActive: true,
  });

  // Deliberately NOT "main" — this is the exact shape that used to 404.
  const realCase = await VisaCaseModel.create({
    tenantId,
    branchId: "KARACHI-OFFICE",
    caseNumber: `VC-BA-${suffix}`,
    travelerId: new mongoose.Types.ObjectId(),
    destinationCountry: "Testland",
  });

  const noteRes = makeRes();
  await addVisaCaseNote(
    { auth: authFor(tenantId), params: { visaCaseId: realCase._id.toString() }, body: { content: "Regression test note" }, requestId: `note-${suffix}`, ip: "127.0.0.1", get: () => null },
    noteRes
  );
  assert.equal(noteRes.statusCode, 201, "addVisaCaseNote must succeed for a case on a non-'main' branch: " + JSON.stringify(noteRes.body));

  const timelineRes = makeRes();
  await getVisaCaseTimeline({ auth: authFor(tenantId), params: { visaCaseId: realCase._id.toString() }, query: {}, requestId: `timeline-${suffix}` }, timelineRes);
  assert.equal(timelineRes.statusCode, 200, "getVisaCaseTimeline must succeed for a case on a non-'main' branch: " + JSON.stringify(timelineRes.body));

  const aiContextRes = makeRes();
  await getVisaCaseAIContext({ auth: authFor(tenantId), params: { visaCaseId: realCase._id.toString() }, requestId: `ai-${suffix}` }, aiContextRes);
  assert.equal(aiContextRes.statusCode, 200, "getVisaCaseAIContext must succeed for a case on a non-'main' branch: " + JSON.stringify(aiContextRes.body));
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
