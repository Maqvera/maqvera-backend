import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { applyEnterpriseMetadata } from "../utils/enterpriseMetadata.js";
import { applyArchivalPolicy } from "../utils/archivalPolicy.js";
import { assertHardDeleteAllowed, archiveRecord, restoreRecord, purgeRecord } from "../utils/archivalService.js";
import { runWithCorrelationId } from "../utils/correlationContext.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Soft Delete & Archival
// Standard (Improvement 10). Real proof against a real, live collection
// (scratch model, same pattern Improvement 1's own test used): the full
// Active -> Archived -> Restored cycle, a real closed-accounting-period
// rejection, and the full Secure Purge gate chain (must be archived, no
// legal hold, retention actually expired, explicit approval) — ending in
// a genuine `deleteOne`, the only hard delete anywhere in this file.
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

test("assertHardDeleteAllowed: financial resource types are never hard-deletable; operational ones are, per the explicit allow-list", () => {
  assert.throws(() => assertHardDeleteAllowed("Invoice"), /never be physically deleted/);
  assert.throws(() => assertHardDeleteAllowed("Journal"), /never be physically deleted/);
  assert.throws(() => assertHardDeleteAllowed("Payment"), /never be physically deleted/);
  assert.doesNotThrow(() => assertHardDeleteAllowed("Cache"));
  assert.doesNotThrow(() => assertHardDeleteAllowed("Session"));
  assert.throws(() => assertHardDeleteAllowed("SomeUnlistedThing"), /not on the explicit hard-delete allow-list/);
});

test("archiveRecord -> restoreRecord: real Active -> Archived -> Restored cycle with audit trail and domain events", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const schema = new mongoose.Schema({ tenantId: { type: String, required: true }, invoiceNumber: { type: String } });
  schema.plugin(applyEnterpriseMetadata);
  applyArchivalPolicy(schema);
  const ScratchInvoiceModel = mongoose.model(`archival_scratch_${Date.now()}`, schema);

  t.after(async () => {
    // Drop the collection itself, not just its documents — see
    // tests/optimisticLockingStandard.test.js's own comment on this same fix.
    await ScratchInvoiceModel.collection.drop().catch(() => {});
    delete mongoose.connection.models[ScratchInvoiceModel.modelName];
  });

  const archivedEvents = [];
  const restoredEvents = [];
  subscribeEvent("RecordArchived.v1", (p) => archivedEvents.push(p));
  subscribeEvent("RecordRestored.v1", (p) => restoredEvents.push(p));

  const tenantId = `test-archival-${Date.now()}`;
  const doc = await ScratchInvoiceModel.create({ tenantId, invoiceNumber: "INV-9001" });

  const archived = await runWithCorrelationId("corr-archival-1", () =>
    archiveRecord({ Model: ScratchInvoiceModel, filter: { _id: doc._id, tenantId }, resourceType: "TestInvoice", reason: "Customer account closed", userId: "user-1", tenantId })
  );
  assert.equal(archived.isArchived, true);
  assert.ok(archived.archivedAt);
  assert.equal(archived.archivedBy, "user-1");
  assert.equal(archived.archiveReason, "Customer account closed");
  assert.ok(archived.purgeEligibleAt, "a real purge-eligibility date is computed at archive time");

  await assert.rejects(
    () => archiveRecord({ Model: ScratchInvoiceModel, filter: { _id: doc._id, tenantId }, resourceType: "TestInvoice", reason: "again", userId: "user-1", tenantId }),
    /already archived/
  );

  const restored = await restoreRecord({ Model: ScratchInvoiceModel, filter: { _id: doc._id, tenantId }, resourceType: "TestInvoice", userId: "user-2", tenantId, correlationId: "corr-archival-2" });
  assert.equal(restored.isArchived, false);
  assert.ok(restored.restoredAt);
  assert.equal(restored.restoredBy, "user-2");
  assert.equal(restored.purgeEligibleAt, null, "restoring clears the purge-eligibility clock");

  await assert.rejects(
    () => restoreRecord({ Model: ScratchInvoiceModel, filter: { _id: doc._id, tenantId }, resourceType: "TestInvoice", userId: "user-2", tenantId }),
    /is not archived/
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(archivedEvents.length, 1);
  assert.equal(archivedEvents[0].correlationId, "corr-archival-1");
  assert.equal(archivedEvents[0].data.resourceId, String(doc._id));
  assert.equal(restoredEvents.length, 1);
  assert.equal(restoredEvents[0].correlationId, "corr-archival-2");

  const auditActions = (await AuditLogModel.find({ resourceId: String(doc._id) }).sort({ createdAt: 1 }).lean()).map((a) => a.action);
  assert.deepEqual(auditActions, ["archival.archived", "archival.restored"]);
});

test("archiveRecord: a closed accounting period rejects the archive attempt and publishes ArchiveRejected.v1", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const FinancialPeriodModel = (await import("../models/FinancialPeriodModel.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const schema = new mongoose.Schema({ tenantId: { type: String, required: true } });
  applyArchivalPolicy(schema);
  const ScratchModel = mongoose.model(`archival_period_scratch_${Date.now()}`, schema);

  t.after(async () => {
    // Drop the collection itself, not just its documents — see
    // tests/optimisticLockingStandard.test.js's own comment on this same fix.
    await ScratchModel.collection.drop().catch(() => {});
    delete mongoose.connection.models[ScratchModel.modelName];
    await FinancialPeriodModel.deleteMany({ tenantId });
  });

  const tenantId = `test-archival-period-${Date.now()}`;
  const periodDate = new Date("2027-01-15T00:00:00.000Z");
  await FinancialPeriodModel.create({ tenantId, periodType: "Monthly", financialYear: "2027", startDate: new Date("2027-01-01"), endDate: new Date("2027-01-31"), status: "Closed", closedAt: new Date(), closedBy: "controller-1" });

  const doc = await ScratchModel.create({ tenantId });

  const rejectedEvents = [];
  subscribeEvent("ArchiveRejected.v1", (p) => rejectedEvents.push(p));

  await assert.rejects(
    () => archiveRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestJournal", reason: "test", tenantId, periodDate, userId: "user-1" }),
    (error) => {
      assert.equal(error.code, "ACCOUNTING_PERIOD_CLOSED");
      assert.equal(error.httpStatus, 422);
      return true;
    }
  );

  const reloaded = await ScratchModel.findById(doc._id).lean();
  assert.equal(reloaded.isArchived, false, "a rejected archive attempt must never partially apply");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(rejectedEvents.length, 1);
  const rejectedAudit = await AuditLogModel.findOne({ action: "archival.rejected", resourceId: String(doc._id) }).lean();
  assert.ok(rejectedAudit);
});

test("purgeRecord: the full secure-purge gate chain — must be archived, no legal hold, retention actually expired, explicit approval", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const schema = new mongoose.Schema({ tenantId: { type: String, required: true }, secretNote: { type: String } });
  applyArchivalPolicy(schema);
  const ScratchModel = mongoose.model(`archival_purge_scratch_${Date.now()}`, schema);

  t.after(async () => {
    // Drop the collection itself, not just its documents — see
    // tests/optimisticLockingStandard.test.js's own comment on this same fix.
    await ScratchModel.collection.drop().catch(() => {});
    delete mongoose.connection.models[ScratchModel.modelName];
  });

  const tenantId = `test-archival-purge-${Date.now()}`;
  const doc = await ScratchModel.create({ tenantId, secretNote: "final snapshot must survive in the audit log" });

  await assert.rejects(
    () => purgeRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestRecord", approvedBy: "cfo-1", tenantId }),
    /must be archived before it can be purged/
  );

  await archiveRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestRecord", reason: "test", tenantId, userId: "user-1" });

  await assert.rejects(
    () => purgeRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestRecord", tenantId }),
    /approvedBy is required/
  );

  await assert.rejects(
    () => purgeRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestRecord", approvedBy: "cfo-1", tenantId }),
    /has not yet reached the end of its retention period/,
    "a freshly-archived record (7-year default retention) is nowhere near purge-eligible"
  );

  await ScratchModel.updateOne({ _id: doc._id }, { $set: { legalHold: true, legalHoldReason: "Active litigation", purgeEligibleAt: new Date(Date.now() - 1000) } });
  await assert.rejects(
    () => purgeRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestRecord", approvedBy: "cfo-1", tenantId }),
    /under legal hold/
  );

  await ScratchModel.updateOne({ _id: doc._id }, { $set: { legalHold: false } });

  const retentionExpiredEvents = [];
  const purgedEvents = [];
  subscribeEvent("RetentionExpired.v1", (p) => retentionExpiredEvents.push(p));
  subscribeEvent("RecordPurged.v1", (p) => purgedEvents.push(p));

  const result = await runWithCorrelationId("corr-purge-1", () =>
    purgeRecord({ Model: ScratchModel, filter: { _id: doc._id, tenantId }, resourceType: "TestRecord", approvedBy: "cfo-1", userId: "ops-1", reason: "Retention expired, no legal hold.", tenantId })
  );
  assert.equal(result.purged, true);
  assert.equal(result.resourceId, String(doc._id));

  const stillThere = await ScratchModel.findById(doc._id).lean();
  assert.equal(stillThere, null, "the document must be genuinely gone — this is the one real hard delete in the whole workflow");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(retentionExpiredEvents.length, 1);
  assert.equal(purgedEvents.length, 1);
  assert.equal(purgedEvents[0].correlationId, "corr-purge-1");
  assert.equal(purgedEvents[0].data.approvedBy, "cfo-1");

  const purgedAudit = await AuditLogModel.findOne({ action: "archival.purged", resourceId: String(doc._id) }).lean();
  assert.ok(purgedAudit, "the purge audit row is the retained record once the document itself is gone");
  assert.equal(purgedAudit.details.approvedBy, "cfo-1");
  assert.equal(purgedAudit.details.snapshot.secretNote, "final snapshot must survive in the audit log");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
