import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { applyEnterpriseMetadata, captureRequestMetadata, exposeVersion } from "../utils/enterpriseMetadata.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Standard Metadata Model. Pure
// schema/plugin behavior needs no live database; only the final
// real-save-increments-__v assertion does.
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

test("applyEnterpriseMetadata adds the standard fields exactly once, opt-in fields only when requested", () => {
  const schema = new mongoose.Schema({ name: { type: String } });
  applyEnterpriseMetadata(schema);

  for (const path of ["createdBy", "updatedBy", "correlationId", "sourceSystem", "createdFromIP", "createdFromDevice"]) {
    assert.ok(schema.path(path), `expected standard field "${path}" to be added`);
  }
  assert.equal(schema.path("companyId"), undefined, "companyId is opt-in, not added by default");
  assert.equal(schema.path("merchantAccountId"), undefined, "merchantAccountId is opt-in, not added by default");
  assert.equal(schema.path("branchId"), undefined, "branchId is opt-in, not added by default");
  assert.equal(schema.options.optimisticConcurrency, true, "optimistic concurrency (__v as the real version counter) is on by default");
});

test("applyEnterpriseMetadata never overrides a field a schema already defines", () => {
  const schema = new mongoose.Schema({
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }
  });
  applyEnterpriseMetadata(schema);

  assert.equal(schema.path("createdBy").instance, "ObjectId", "a pre-existing createdBy definition must survive untouched, not be overwritten by the plugin's own String default");
});

test("applyEnterpriseMetadata adds companyId/merchantAccountId/branchId only when explicitly opted in", () => {
  const schema = new mongoose.Schema({ name: { type: String } });
  applyEnterpriseMetadata(schema, { includeCompany: true, includeMerchant: true, includeBranch: true });

  assert.ok(schema.path("companyId"));
  assert.ok(schema.path("merchantAccountId"));
  assert.ok(schema.path("branchId"));
});

test("applyEnterpriseMetadata: optimisticConcurrency: false plugin option opts a schema out", () => {
  const schema = new mongoose.Schema({ name: { type: String } });
  applyEnterpriseMetadata(schema, { optimisticConcurrency: false });
  assert.equal(schema.options.optimisticConcurrency, false, "a model that explicitly passes optimisticConcurrency: false to the plugin must stay opted out");
});

test("captureRequestMetadata derives correlationId/sourceSystem/createdFromIP/createdFromDevice from a real request object", () => {
  const fakeReq = {
    requestId: "req-abc-123",
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "TestAgent/1.0" },
    header(name) {
      const key = name.toLowerCase();
      if (key === "x-source-system") return null;
      if (key === "user-agent") return this.headers["user-agent"];
      return null;
    },
    ip: "10.0.0.1"
  };

  const meta = captureRequestMetadata(fakeReq);
  assert.deepEqual(meta, {
    correlationId: "req-abc-123",
    sourceSystem: "api",
    createdFromIP: "203.0.113.7",
    createdFromDevice: "TestAgent/1.0"
  });
});

test("captureRequestMetadata honors an explicit X-Source-System header", () => {
  const fakeReq = {
    requestId: "req-xyz",
    headers: {},
    header(name) {
      if (name.toLowerCase() === "x-source-system") return "mobile-app";
      return null;
    },
    ip: "127.0.0.1"
  };
  assert.equal(captureRequestMetadata(fakeReq).sourceSystem, "mobile-app");
});

test("exposeVersion renames __v to version without leaking the internal field name", () => {
  const doc = { __v: 3 };
  const ret = { name: "test", __v: 3 };
  const result = exposeVersion(doc, ret);
  assert.equal(result.version, 3);
  assert.equal(result.__v, undefined);
});

test("optimisticConcurrency: a real save increments __v", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const schema = new mongoose.Schema({ name: { type: String } });
  applyEnterpriseMetadata(schema);
  const ScratchModel = mongoose.model(`enterprise_metadata_scratch_${Date.now()}`, schema);
  t.after(async () => {
    // Drop the collection itself, not just its documents — see
    // tests/optimisticLockingStandard.test.js's own comment on this same fix.
    await ScratchModel.collection.drop().catch(() => {});
    delete mongoose.connection.models[ScratchModel.modelName];
  });

  const doc = await ScratchModel.create({ name: "first" });
  assert.equal(doc.__v, 0);

  doc.name = "second";
  await doc.save();
  assert.equal(doc.__v, 1, "a real document save increments the optimistic-concurrency version counter");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
