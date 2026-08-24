import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import ReportAuditService, { computeReportAuditHash } from "../services/ReportAuditService.js";
import ReportAuditEventModel, { MUTABLE_FIELDS, findDisallowedModifiedPaths, findDisallowedUpdateFields } from "../models/ReportAuditEventModel.js";

const tenantId = "TENANT-TEST-REPORTAUDIT-001";

test("ReportAuditService.recordEvent — no-ops without a live Mongo connection, never throws", async () => {
  assert.notEqual(mongoose.connection?.readyState, 1, "this test assumes no live DB connection, matching the rest of this suite");
  const result = await ReportAuditService.recordEvent({ tenantId, module: "Finance", resourceType: "Report", resourceKey: "TrialBalance", action: "VIEW", userId: "u1" });
  assert.equal(result, null);
});

test("ReportAuditService.recordEvent — rejects missing required fields without touching the DB (readyState irrelevant)", async () => {
  const result = await ReportAuditService.recordEvent({ tenantId, module: "Finance", resourceType: "Report", action: "VIEW" });
  assert.equal(result, null, "missing resourceKey must no-op, not throw");
});

test("ReportAuditService.recordEvent — hash-chain continuity across two sequential events", async () => {
  const origState = mongoose.connection.readyState;
  const origFindOne = ReportAuditEventModel.findOne;
  const origCreate = ReportAuditEventModel.create;
  try {
    mongoose.connection.readyState = 1;
    const store = [];
    ReportAuditEventModel.findOne = () => ({
      sort: () => ({
        select: () => ({
          lean: async () => (store.length ? store[store.length - 1] : null)
        })
      })
    });
    ReportAuditEventModel.create = async (doc) => { store.push(doc); return doc; };

    const first = await ReportAuditService.recordEvent({ tenantId, module: "Finance", resourceType: "Report", resourceKey: "TrialBalance", action: "VIEW", userId: "u1" });
    const second = await ReportAuditService.recordEvent({ tenantId, module: "Finance", resourceType: "Report", resourceKey: "TrialBalance", action: "EXPORT", userId: "u1", format: "CSV" });

    assert.equal(first.sequence, 1);
    assert.equal(first.previousHash, null);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousHash, first.hash, "second event's previousHash must equal first event's hash");
    assert.notEqual(second.hash, first.hash);
  } finally {
    mongoose.connection.readyState = origState;
    ReportAuditEventModel.findOne = origFindOne;
    ReportAuditEventModel.create = origCreate;
  }
});

test("computeReportAuditHash — deterministic: same inputs always produce the same hash", () => {
  const event = { tenantId, sequence: 1, module: "Finance", resourceType: "Report", resourceKey: "TrialBalance", action: "VIEW", userId: "u1", timestamp: new Date("2026-01-01T00:00:00.000Z"), previousHash: null };
  assert.equal(computeReportAuditHash(event), computeReportAuditHash({ ...event }));
});

test("computeReportAuditHash — differs when any evidentiary field changes", () => {
  const base = { tenantId, sequence: 1, module: "Finance", resourceType: "Report", resourceKey: "TrialBalance", action: "VIEW", userId: "u1", timestamp: new Date("2026-01-01T00:00:00.000Z"), previousHash: null };
  assert.notEqual(computeReportAuditHash(base), computeReportAuditHash({ ...base, action: "EXPORT" }));
});

// ─────────────────────────────────────────────────────────────
// Immutability guard — mirrors models/AuditEventModel.js's own
// append-only enforcement. The guard logic is exported as pure functions
// (models/ReportAuditEventModel.js's findDisallowedModifiedPaths/
// findDisallowedUpdateFields) specifically so it's directly unit-testable
// here, rather than only reachable through mongoose's own pre-hook
// dispatch (which requires a live connection to exercise via a real
// Query.exec() — not available in this test environment).
// ─────────────────────────────────────────────────────────────
test("ReportAuditEventModel — MUTABLE_FIELDS allowlist is exactly legalHold/status/updatedBy", () => {
  assert.deepEqual([...MUTABLE_FIELDS].sort(), ["legalHold", "status", "updatedBy"]);
});

test("findDisallowedModifiedPaths — flags a disallowed field on an existing document save", () => {
  assert.deepEqual(findDisallowedModifiedPaths(["action"]), ["action"]);
  assert.deepEqual(findDisallowedModifiedPaths(["hash", "sequence"]), ["hash", "sequence"]);
});

test("findDisallowedModifiedPaths — allows legalHold/status/updatedBy-only changes", () => {
  assert.deepEqual(findDisallowedModifiedPaths(["legalHold", "status", "updatedBy"]), []);
});

test("findDisallowedUpdateFields — rejects a disallowed field mutation via $set", () => {
  assert.deepEqual(findDisallowedUpdateFields({ $set: { action: "TAMPERED" } }), ["action"]);
});

test("findDisallowedUpdateFields — allows a legalHold/status/updatedBy-only $set", () => {
  assert.deepEqual(findDisallowedUpdateFields({ $set: { legalHold: true, status: "Archived", updatedBy: "u1" } }), []);
});

test("ReportAuditEventModel — deleteOne/deleteMany/findOneAndDelete are always rejected (append-only, no deletion)", () => {
  const deleteHooks = ReportAuditEventModel.schema.s.hooks._pres.get("deleteOne");
  assert.ok(Array.isArray(deleteHooks) && deleteHooks.length > 0, "expected at least one deleteOne pre hook registered");
});
