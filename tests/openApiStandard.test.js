import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { load as loadYaml } from "js-yaml";

// Enterprise Architecture Hardening Phase — Enterprise OpenAPI / Swagger /
// SDK Generation Standard (Improvement 15). No MongoDB dependency — this
// standard's own artifacts (the spec object, the generator script, the
// route source) are all pure/static, so every test here runs unguarded,
// same as tests/errorContractStandard.test.js and tests/paginationStandard.test.js.

test("swaggerSpec: real reusable schema components exist with the shapes the standard requires", async () => {
  const { swaggerSpec } = await import("../config/swaggerConfig.js");

  assert.equal(swaggerSpec.openapi, "3.0.0");
  assert.ok(swaggerSpec.info.version, "the OpenAPI document has its own real version, independent of the URL-level API version");

  const { ErrorResponse, PaginatedResponse, EnterpriseEventEnvelope } = swaggerSpec.components.schemas;
  assert.ok(ErrorResponse, "ErrorResponse component must exist");
  assert.ok(ErrorResponse.properties.data.properties.code, "ErrorResponse must reflect the REAL Enterprise Standard Error Contract shape (code/category/severity/...), not the older generic shape");
  assert.ok(ErrorResponse.properties.data.properties.correlationId);
  assert.deepEqual(ErrorResponse.properties.data.properties.category.enum, ["Validation", "Business", "Authorization", "Authentication", "NotFound", "Conflict", "RateLimit", "Integration", "Infrastructure", "System"]);

  assert.ok(PaginatedResponse, "PaginatedResponse component must exist");
  assert.ok(PaginatedResponse.properties.pagination.properties.totalPages, "must reflect the real Enterprise Pagination Standard envelope shape");

  assert.ok(EnterpriseEventEnvelope, "EnterpriseEventEnvelope component must exist");
  assert.ok(EnterpriseEventEnvelope.properties.eventVersion, "must reflect the real Enterprise Event Versioning Standard envelope");

  const { RateLimitLimit, RateLimitRemaining, RateLimitReset, RetryAfter } = swaggerSpec.components.headers;
  assert.ok(RateLimitLimit && RateLimitRemaining && RateLimitReset && RetryAfter, "reusable rate-limit response headers must exist (Enterprise API Rate Limiting Standard)");
});

test("swaggerSpec: the flagship POST /payments endpoint is real JSDoc-driven documentation, not a placeholder", async () => {
  const { swaggerSpec } = await import("../config/swaggerConfig.js");

  const paymentsPath = swaggerSpec.paths["/payments"];
  assert.ok(paymentsPath, "swagger-jsdoc must have picked up the @swagger block from routes/FinanceRoutes.js");
  const post = paymentsPath.post;
  assert.deepEqual(post.tags, ["Finance — Payments"]);
  assert.ok(post.responses["201"] && post.responses["402"] && post.responses["400"] && post.responses["403"], "every real status this endpoint's own controller can return must be documented");
  assert.ok(Array.isArray(post["x-code-samples"]) && post["x-code-samples"].length >= 2, "real cURL + JavaScript code samples must be present");
  const langs = post["x-code-samples"].map((s) => s.lang);
  assert.ok(langs.includes("cURL") && langs.includes("JavaScript"));
});

test("swaggerSpec: pre-existing hand-authored paths are untouched by the JSDoc addition", async () => {
  const { swaggerSpec } = await import("../config/swaggerConfig.js");
  assert.ok(swaggerSpec.paths["/auth/login"], "the original hand-authored path catalog must still be present, additive-only change");
  assert.equal(swaggerSpec.paths["/auth/login"].post.tags[0], "Authentication");
});

test("server.js: real /openapi.json and /openapi.yaml routes are registered against the same swaggerSpec /api-docs uses", () => {
  const serverSource = fs.readFileSync(path.join(import.meta.dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /app\.get\(["']\/openapi\.json["'],[\s\S]{0,80}swaggerSpec/, "GET /openapi.json must serve the real swaggerSpec object");
  assert.match(serverSource, /app\.get\(["']\/openapi\.yaml["'],[\s\S]{0,120}dumpYaml\(swaggerSpec\)/, "GET /openapi.yaml must serve a real YAML serialization of the SAME swaggerSpec object");
});

test("swaggerSpec YAML round-trip: js-yaml can serialize and re-parse the full spec back to an equivalent object", async () => {
  const { swaggerSpec } = await import("../config/swaggerConfig.js");
  const { dump } = await import("js-yaml");
  const yamlString = dump(swaggerSpec);
  const reparsed = loadYaml(yamlString);
  assert.deepEqual(reparsed, JSON.parse(JSON.stringify(swaggerSpec)), "the /openapi.yaml response must be a faithful, lossless representation of the same document /openapi.json serves");
});

test("generate:openapi script: real end-to-end generation — versioned JSON/YAML snapshot + real TypeScript SDK types", async (t) => {
  const repoRoot = path.join(import.meta.dirname, "..");
  const { swaggerSpec } = await import("../config/swaggerConfig.js");
  const currentVersion = `v${swaggerSpec.info.version.split(".")[0]}`;
  const jsonPath = path.join(repoRoot, "docs", "openapi", `${currentVersion}.json`);
  const yamlPath = path.join(repoRoot, "docs", "openapi", `${currentVersion}.yaml`);
  const sdkPath = path.join(repoRoot, "docs", "sdk", "typescript", "index.d.ts");

  const preExistingJson = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, "utf8") : null;

  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generateOpenApiArtifacts.js")], { cwd: repoRoot, timeout: 30000 });

  t.after(() => { if (preExistingJson !== null) fs.writeFileSync(jsonPath, preExistingJson); });

  assert.ok(fs.existsSync(jsonPath), `${currentVersion}.json snapshot must be written`);
  assert.ok(fs.existsSync(yamlPath), `${currentVersion}.yaml snapshot must be written`);

  const writtenSpec = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.deepEqual(writtenSpec, JSON.parse(JSON.stringify(swaggerSpec)), "the written snapshot must be the exact live spec, never a stale or hand-edited copy");

  assert.ok(fs.existsSync(sdkPath), "real TypeScript SDK types must be generated (openapi-typescript is installed in this environment)");
  const sdkContent = fs.readFileSync(sdkPath, "utf8");
  assert.match(sdkContent, /export interface paths \{/, "the generated file must be real TypeScript, not a placeholder");
  assert.match(sdkContent, /"\/payments"/, "the generated SDK types must include the flagship JSDoc-documented endpoint");
});
