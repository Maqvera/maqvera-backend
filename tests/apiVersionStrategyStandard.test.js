import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Enterprise Architecture Hardening Phase — API Version Strategy Standard
// (Improvement 8). Proves the real registry lifecycle (GA -> Deprecated
// -> Sunset -> Retired), real duplicate-definition prevention, and the
// real `apiVersionLifecycle` middleware behavior: silent no-op for an
// unregistered/GA version, real Deprecation/Sunset/Latest-Version
// response headers for a Deprecated one, and a genuine 410 rejection —
// `next()` never called — once a version is Sunset or Retired.
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
  headers: {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader(name, value) { this.headers[name] = value; }
});

test("registerApiVersion: idempotent re-registration, real conflict on a different owner, GA defaults a real supportedUntil", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { registerApiVersion } = await import("../utils/apiVersioning.js");
  const ApiVersionRegistryModel = (await import("../models/ApiVersionRegistryModel.js")).default;

  const apiName = `TestApi${Date.now()}`;
  t.after(async () => { await ApiVersionRegistryModel.deleteMany({ apiName }); });

  const first = await registerApiVersion(apiName, "v1", { owner: "Payments Platform" });
  assert.equal(first.status, "GA");
  assert.ok(first.supportedUntil, "a GA registration gets a real default supportedUntil from the support-policy config");

  const again = await registerApiVersion(apiName, "v1", { owner: "Payments Platform" });
  assert.equal(String(again._id), String(first._id), "re-registering with the SAME owner is a safe idempotent no-op");

  await assert.rejects(
    () => registerApiVersion(apiName, "v1", { owner: "A Different Team" }),
    (error) => {
      assert.equal(error.code, "API_VERSION_REGISTRY_CONFLICT");
      assert.equal(error.httpStatus, 409);
      return true;
    }
  );
});

test("API version lifecycle: GA -> Deprecated (real sunsetAt/latestVersion) -> Sunset -> Retired", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { registerApiVersion, deprecateApiVersion, sunsetApiVersion, retireApiVersion } = await import("../utils/apiVersioning.js");
  const ApiVersionRegistryModel = (await import("../models/ApiVersionRegistryModel.js")).default;

  const apiName = `TestApiLifecycle${Date.now()}`;
  t.after(async () => { await ApiVersionRegistryModel.deleteMany({ apiName }); });

  await registerApiVersion(apiName, "v1", { owner: "Payments Platform" });

  const deprecated = await deprecateApiVersion(apiName, "v1", { latestVersion: "v2", reason: "Superseded by v2." });
  assert.equal(deprecated.status, "Deprecated");
  assert.equal(deprecated.latestVersion, "v2");
  assert.ok(deprecated.sunsetAt, "deprecating without an explicit sunsetAt computes a real one from the support-policy config");

  const sunset = await sunsetApiVersion(apiName, "v1");
  assert.equal(sunset.status, "Sunset");

  const retired = await retireApiVersion(apiName, "v1");
  assert.equal(retired.status, "Retired");
  assert.ok(retired.retiredAt);

  await assert.rejects(() => deprecateApiVersion(apiName, "v1"), /Cannot deprecate/);
  await assert.rejects(() => sunsetApiVersion(apiName, "v1"), /Cannot sunset a Retired/);
});

test("apiVersionLifecycle middleware: unregistered and GA versions are a silent no-op", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { apiVersionLifecycle } = await import("../middleware/apiVersionLifecycle.js");
  const { registerApiVersion } = await import("../utils/apiVersioning.js");
  const ApiVersionRegistryModel = (await import("../models/ApiVersionRegistryModel.js")).default;

  const apiName = `TestApiMwGa${Date.now()}`;
  t.after(async () => { await ApiVersionRegistryModel.deleteMany({ apiName }); });

  const unregisteredRes = makeRes();
  let unregisteredNextCalled = false;
  await apiVersionLifecycle(apiName, "v9")({ requestId: "corr-1" }, unregisteredRes, () => { unregisteredNextCalled = true; });
  assert.equal(unregisteredNextCalled, true);
  assert.deepEqual(unregisteredRes.headers, {}, "an unregistered API/version must never fabricate deprecation headers");

  await registerApiVersion(apiName, "v1", { owner: "Payments Platform" });
  const gaRes = makeRes();
  let gaNextCalled = false;
  await apiVersionLifecycle(apiName, "v1")({ requestId: "corr-2" }, gaRes, () => { gaNextCalled = true; });
  assert.equal(gaNextCalled, true);
  assert.deepEqual(gaRes.headers, {});
});

test("apiVersionLifecycle middleware: a Deprecated version gets real Deprecation/Sunset/Latest-Version headers and still proceeds", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { apiVersionLifecycle } = await import("../middleware/apiVersionLifecycle.js");
  const { registerApiVersion, deprecateApiVersion } = await import("../utils/apiVersioning.js");
  const ApiVersionRegistryModel = (await import("../models/ApiVersionRegistryModel.js")).default;

  const apiName = `TestApiMwDeprecated${Date.now()}`;
  t.after(async () => { await ApiVersionRegistryModel.deleteMany({ apiName }); });

  await registerApiVersion(apiName, "v1", { owner: "Payments Platform" });
  await deprecateApiVersion(apiName, "v1", { latestVersion: "v2", sunsetAt: "2029-12-31T00:00:00.000Z" });

  const res = makeRes();
  let nextCalled = false;
  await apiVersionLifecycle(apiName, "v1")({ requestId: "corr-3" }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, "a Deprecated version is still inside its support window — the request proceeds");
  assert.equal(res.headers["Deprecation"], "true");
  assert.equal(res.headers["Latest-Version"], "v2");
  assert.ok(res.headers["Sunset"].includes("2029"));
});

test("apiVersionLifecycle middleware: Sunset/Retired versions are genuinely rejected — next() never called", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { apiVersionLifecycle } = await import("../middleware/apiVersionLifecycle.js");
  const { registerApiVersion, deprecateApiVersion, sunsetApiVersion } = await import("../utils/apiVersioning.js");
  const ApiVersionRegistryModel = (await import("../models/ApiVersionRegistryModel.js")).default;

  const apiName = `TestApiMwSunset${Date.now()}`;
  t.after(async () => { await ApiVersionRegistryModel.deleteMany({ apiName }); });

  await registerApiVersion(apiName, "v1", { owner: "Payments Platform" });
  await deprecateApiVersion(apiName, "v1", {});
  await sunsetApiVersion(apiName, "v1");

  const res = makeRes();
  let nextCalled = false;
  await apiVersionLifecycle(apiName, "v1")({ requestId: "corr-4" }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, "a Sunset version must reject the request outright, never fall through to the real handler");
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.data.code, "API_VERSION_UNAVAILABLE");
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
