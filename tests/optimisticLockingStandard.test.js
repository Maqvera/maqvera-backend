import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import {
  extractRequestedVersion,
  assertMutableResource,
  applyOptimisticUpdate,
  sendVersionConflict,
  VersionConflictError,
  VersionRequiredError
} from "../utils/optimisticLocking.js";
import { applyEnterpriseMetadata } from "../utils/enterpriseMetadata.js";

dotenv.config();

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

test("extractRequestedVersion prefers body.version, falls back to If-Match, else null", () => {
  assert.equal(extractRequestedVersion({ body: { version: 8 } }), 8);
  assert.equal(extractRequestedVersion({ body: {}, header: (n) => (n === "If-Match" ? '"8"' : null) }), 8);
  assert.equal(extractRequestedVersion({ body: {}, header: (n) => (n === "If-Match" ? "W/8" : null) }), 8);
  assert.equal(extractRequestedVersion({ body: {}, header: () => null, headers: {} }), null);
  assert.equal(extractRequestedVersion({ body: { version: 0 } }), 0, "version 0 is a real, valid version, not treated as missing");
});

test("assertMutableResource rejects configured immutable resource types, allows everything else", () => {
  assert.throws(() => assertMutableResource("Journal"), /immutable/);
  assert.throws(() => assertMutableResource("PostedInvoice"), /immutable/);
  assert.doesNotThrow(() => assertMutableResource("Invoice"));
  assert.doesNotThrow(() => assertMutableResource(null));
});

test("sendVersionConflict produces the standard { code, category, severity, httpStatus, correlationId, timestamp, currentVersion } envelope", () => {
  let captured = null;
  const fakeRes = {
    status(code) {
      captured = { statusCode: code };
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    }
  };
  const error = new VersionConflictError("Resource has been modified by another user.", 9);
  sendVersionConflict(fakeRes, error, "corr-abc-123");

  assert.equal(captured.statusCode, 409);
  assert.equal(captured.body.success, false);
  assert.equal(captured.body.message, "Resource has been modified by another user.");
  assert.equal(captured.body.data.code, "VERSION_CONFLICT");
  assert.equal(captured.body.data.category, "Concurrency");
  assert.equal(captured.body.data.severity, "Error");
  assert.equal(captured.body.data.httpStatus, 409);
  assert.equal(captured.body.data.currentVersion, 9);
  assert.equal(captured.body.data.correlationId, "corr-abc-123");
  assert.ok(!Number.isNaN(Date.parse(captured.body.data.timestamp)), "timestamp must be a real, parseable ISO date");
  assert.equal(captured.body.requestId, "corr-abc-123");
});

test("applyOptimisticUpdate: real lost-update prevention against a live document", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const schema = new mongoose.Schema({ tenantId: { type: String, required: true }, amount: { type: Number } });
  applyEnterpriseMetadata(schema);
  const ScratchInvoiceModel = mongoose.model(`optimistic_locking_scratch_${Date.now()}`, schema);

  t.after(async () => {
    // Drop the actual collection, not just its documents — this schema is
    // registered under a fresh Date.now()-suffixed name every run
    // specifically so it never collides with a real collection, which
    // means deleteMany alone leaves an empty, permanent collection shell
    // behind on every single test run (confirmed: 259 leaked scratch
    // collections had pushed the shared cluster to its 500-collection cap).
    await ScratchInvoiceModel.collection.drop().catch(() => {});
    delete mongoose.connection.models[ScratchInvoiceModel.modelName];
  });

  const tenantId = `test-ol-${Date.now()}`;
  const correlationId = `corr-${Date.now()}`;
  const invoice = await ScratchInvoiceModel.create({ tenantId, amount: 10000 });
  assert.equal(invoice.__v, 0);

  // Manager A reads version 0, then successfully saves.
  const afterA = await applyOptimisticUpdate({
    Model: ScratchInvoiceModel,
    filter: { _id: invoice._id, tenantId },
    requestedVersion: 0,
    update: { $set: { amount: 10000 } },
    resourceType: "Invoice",
    tenantId,
    correlationId,
    userId: "manager-a"
  });
  assert.equal(afterA.amount, 10000);
  assert.equal(afterA.__v, 1, "a successful optimistic update atomically increments the version");

  // Manager B still holds the STALE version 0 read before A's save landed —
  // this is the exact lost-update scenario the standard exists to prevent.
  await assert.rejects(
    () => applyOptimisticUpdate({
      Model: ScratchInvoiceModel,
      filter: { _id: invoice._id, tenantId },
      requestedVersion: 0,
      update: { $set: { amount: 15000 } },
      resourceType: "Invoice",
      tenantId,
      correlationId,
      userId: "manager-b"
    }),
    (error) => {
      assert.ok(error instanceof VersionConflictError);
      assert.equal(error.currentVersion, 1, "the conflict response must report the REAL current version, not the stale one Manager B sent");
      assert.equal(error.code, "VERSION_CONFLICT");
      return true;
    }
  );

  // B's change was never applied — A's write is not silently overwritten.
  const finalState = await ScratchInvoiceModel.findById(invoice._id).lean();
  assert.equal(finalState.amount, 10000, "the lost-update was actually prevented, not just detected after the fact");

  // "Every version conflict MUST be audit logged with its correlationId."
  const conflictAudit = await AuditLogModel.findOne({ action: "concurrency.version_conflict", resourceId: String(invoice._id) }).lean();
  assert.ok(conflictAudit, "the version conflict must produce a real audit log row");
  assert.equal(conflictAudit.requestId, correlationId);
  assert.equal(conflictAudit.details.currentVersion, 1);
  assert.equal(conflictAudit.details.requestedVersion, 0);

  // Retrying with the now-current version succeeds.
  const afterB = await applyOptimisticUpdate({
    Model: ScratchInvoiceModel,
    filter: { _id: invoice._id, tenantId },
    requestedVersion: 1,
    update: { $set: { amount: 15000 } },
    resourceType: "Invoice",
    tenantId,
    correlationId,
    userId: "manager-b"
  });
  assert.equal(afterB.amount, 15000);
  assert.equal(afterB.__v, 2);

  await t.test("missing version throws VersionRequiredError, not a silent update", async () => {
    await assert.rejects(
      () => applyOptimisticUpdate({ Model: ScratchInvoiceModel, filter: { _id: invoice._id, tenantId }, requestedVersion: null, update: { $set: { amount: 99999 } }, resourceType: "Invoice" }),
      (error) => error instanceof VersionRequiredError && error.code === "VERSION_REQUIRED"
    );
  });

  await t.test("a genuinely nonexistent document reports not-found, not a version conflict", async () => {
    await assert.rejects(
      () => applyOptimisticUpdate({ Model: ScratchInvoiceModel, filter: { _id: new mongoose.Types.ObjectId(), tenantId }, requestedVersion: 0, update: { $set: { amount: 1 } }, resourceType: "Invoice" }),
      /not found/
    );
  });

  await t.test("Journal (immutable) rejects any update attempt outright", async () => {
    await assert.rejects(
      () => applyOptimisticUpdate({ Model: ScratchInvoiceModel, filter: { _id: invoice._id, tenantId }, requestedVersion: 2, update: { $set: { amount: 1 } }, resourceType: "Journal" }),
      /immutable/
    );
  });
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
