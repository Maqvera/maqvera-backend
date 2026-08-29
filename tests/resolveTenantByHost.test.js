import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Per-Tenant Domain-Masked Landing Page (PRD v2 §Task C) — unit tests for
// middleware/resolveTenantByHost.js in isolation, per that task's own
// instruction, before it's ever wired into a route. Covers: subdomain
// match, unverified custom domain correctly refused, verified custom
// domain match, and an unknown host resolving to null (never a thrown
// error — the middleware must always call next()).

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

const makeReq = (host) => ({ headers: { host } });
const makeRes = () => ({});

test("resolveTenantByHost: subdomain match, verified/unverified custom domain, unknown host, port stripped", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const resolveTenantByHost = (await import("../middleware/resolveTenantByHost.js")).default;
  const TenantProfileModel = (await import("../models/TenantProfileModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-hostresolve-${suffix}`;
  const slug = `test-agency-${suffix}`;
  const verifiedDomain = `www.verified-${suffix}.example`;
  const unverifiedDomain = `www.unverified-${suffix}.example`;

  t.after(async () => {
    await TenantProfileModel.deleteMany({ tenantId });
  });

  await TenantProfileModel.create({
    tenantId, companyName: `Test Agency ${suffix}`, publicSlug: slug,
    customDomain: verifiedDomain, customDomainStatus: "verified"
  });
  const otherTenantId = `test-hostresolve-other-${suffix}`;
  t.after(async () => { await TenantProfileModel.deleteMany({ tenantId: otherTenantId }); });
  await TenantProfileModel.create({
    tenantId: otherTenantId, companyName: `Other Agency ${suffix}`,
    customDomain: unverifiedDomain, customDomainStatus: "pending_dns"
  });

  // getRootDomain() re-reads process.env on every call (not frozen at
  // module load), so overriding it per-test is safe and takes effect immediately.
  const originalRootDomain = process.env.PLATFORM_ROOT_DOMAIN;
  process.env.PLATFORM_ROOT_DOMAIN = "maqvera.test";
  t.after(() => { process.env.PLATFORM_ROOT_DOMAIN = originalRootDomain; });

  // ---- Subdomain match ----
  const reqSubdomain = makeReq(`${slug}.maqvera.test`);
  await resolveTenantByHost(reqSubdomain, makeRes(), () => {});
  assert.equal(reqSubdomain.resolvedTenantId, tenantId);
  assert.equal(reqSubdomain.resolvedTenantSlug, slug);

  // ---- Bare root domain / www -> never resolves a tenant ----
  const reqRoot = makeReq("maqvera.test");
  await resolveTenantByHost(reqRoot, makeRes(), () => {});
  assert.equal(reqRoot.resolvedTenantId, null);

  // ---- Unknown host -> resolves to null, never throws, always calls next() ----
  const reqUnknown = makeReq("totally-unrelated-host.example:443");
  let nextCalled = false;
  await resolveTenantByHost(reqUnknown, makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, "next() must always be called, even for an unresolved host");
  assert.equal(reqUnknown.resolvedTenantId, null);

  // ---- Verified custom domain -> resolves ----
  const reqVerified = makeReq(verifiedDomain);
  await resolveTenantByHost(reqVerified, makeRes(), () => {});
  assert.equal(reqVerified.resolvedTenantId, tenantId);

  // ---- Unverified/pending custom domain -> must NOT resolve ----
  const reqUnverified = makeReq(unverifiedDomain);
  await resolveTenantByHost(reqUnverified, makeRes(), () => {});
  assert.equal(reqUnverified.resolvedTenantId, null, "a pending_dns custom domain must never resolve a tenant — only a verified one");

  // ---- Port in Host header is stripped before matching ----
  const reqPort = makeReq(`${verifiedDomain}:8443`);
  await resolveTenantByHost(reqPort, makeRes(), () => {});
  assert.equal(reqPort.resolvedTenantId, tenantId);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
