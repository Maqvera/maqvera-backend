import test from "node:test";
import assert from "node:assert/strict";
import Joi from "joi";
import { AppError, ERROR_CATALOG, ERROR_CATEGORIES, buildErrorPayload, sendStandardError, fieldDetailsFromJoiError } from "../utils/errorContract.js";
import validate from "../middleware/validateRequest.js";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler.js";

// Enterprise Architecture Hardening Phase — Standard Error Contract
// (Improvement 4). Pure, synchronous — no live database needed to prove
// any of this.

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

test("AppError picks up category/httpStatus/message from the catalog for a known code", () => {
  const error = new AppError("INSUFFICIENT_BALANCE");
  assert.equal(error.code, "INSUFFICIENT_BALANCE");
  assert.equal(error.category, "Business");
  assert.equal(error.httpStatus, 409);
  assert.equal(error.severity, "Error");
  assert.equal(error.message, ERROR_CATALOG.INSUFFICIENT_BALANCE.message);
});

test("AppError allows per-call-site overrides without losing catalog defaults", () => {
  const error = new AppError("VALIDATION_FAILED", { message: "currency is required", details: [{ field: "currency", message: "currency is required" }] });
  assert.equal(error.category, "Validation");
  assert.equal(error.httpStatus, 400);
  assert.equal(error.message, "currency is required");
  assert.deepEqual(error.details, [{ field: "currency", message: "currency is required" }]);
});

test("AppError falls back honestly for an unknown code — System/500/Critical, never a guessed classification", () => {
  const error = new AppError("SOME_CODE_NOT_IN_THE_CATALOG");
  assert.equal(error.category, "System");
  assert.equal(error.httpStatus, 500);
  assert.equal(error.severity, "Critical");
  assert.equal(error.message, "SOME_CODE_NOT_IN_THE_CATALOG");
});

test("every catalog entry uses one of the spec's own real categories", () => {
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    assert.ok(ERROR_CATEGORIES.includes(entry.category), `${code} has an unrecognized category "${entry.category}"`);
  }
});

test("buildErrorPayload includes the full standard shape and omits details when absent", () => {
  const error = new AppError("PERMISSION_DENIED");
  const payload = buildErrorPayload(error, "corr-1");
  assert.equal(payload.code, "PERMISSION_DENIED");
  assert.equal(payload.category, "Authorization");
  assert.equal(payload.severity, "Error");
  assert.equal(payload.httpStatus, 403);
  assert.equal(payload.correlationId, "corr-1");
  assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));
  assert.equal("details" in payload, false, "absent details must not appear as a noisy null key");
});

test("buildErrorPayload includes details when the error carries them", () => {
  const error = new AppError("VALIDATION_FAILED", { details: [{ field: "amount", message: "Amount must be greater than zero." }] });
  const payload = buildErrorPayload(error, null);
  assert.deepEqual(payload.details, [{ field: "amount", message: "Amount must be greater than zero." }]);
});

test("sendStandardError sends the real HTTP status from the catalog and supports extra fields", () => {
  const res = makeRes();
  sendStandardError(res, new AppError("BUDGET_EXCEEDED"), "corr-2", { budgetId: "BUD-1" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.success, false);
  assert.equal(res.body.data.code, "BUDGET_EXCEEDED");
  assert.equal(res.body.data.budgetId, "BUD-1");
  assert.equal(res.body.requestId, "corr-2");
});

test("fieldDetailsFromJoiError maps Joi's own error.details to { field, message }", () => {
  const schema = Joi.object({
    currency: Joi.string().required(),
    amount: Joi.number().greater(0).required()
  });
  const { error } = schema.validate({}, { abortEarly: false });
  const details = fieldDetailsFromJoiError(error);
  assert.equal(details.length, 2);
  assert.ok(details.some((d) => d.field === "currency"));
  assert.ok(details.some((d) => d.field === "amount"));
  assert.ok(details.every((d) => typeof d.message === "string" && d.message.length > 0));
});

test("validate() middleware: field-level details are real and additive, top-level message stays the same joined string", () => {
  const schema = Joi.object({
    currency: Joi.string().required(),
    amount: Joi.number().greater(0).required()
  });
  const req = { body: {} };
  const res = makeRes();
  let nextCalled = false;
  validate(schema)(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "\"currency\" is required; \"amount\" is required", "the existing joined-message format must be unchanged for backward compatibility");
  assert.equal(res.body.data.code, "VALIDATION_FAILED");
  assert.equal(res.body.data.category, "Validation");
  assert.equal(res.body.data.details.length, 2);
  assert.deepEqual(res.body.data.details.map((d) => d.field).sort(), ["amount", "currency"]);
});

test("validate() middleware: a passing request calls next() with the sanitized value, unaffected by the error-contract change", () => {
  const schema = Joi.object({ currency: Joi.string().required() });
  const req = { body: { currency: "USD", extra: "stripped" } };
  const res = makeRes();
  let nextCalled = false;
  validate(schema)(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null, "no response should be sent on a passing validation");
  assert.deepEqual(req.body, { currency: "USD" }, "stripUnknown behavior is unchanged");
});

test("errorHandler: unhandled error produces the standard INTERNAL_ERROR contract and never leaks the stack", () => {
  const req = { requestId: "corr-3", method: "GET", url: "/x", originalUrl: "/api/v1/x" };
  const res = makeRes();
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    errorHandler(new Error("db connection refused at 10.0.0.5:27017"), req, res, () => {});
  } finally {
    process.env.NODE_ENV = originalEnv;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.data.code, "INTERNAL_ERROR");
  assert.equal(res.body.data.category, "System");
  assert.equal(res.body.data.severity, "Critical");
  assert.equal(res.body.requestId, "corr-3");
});

test("errorHandler: production hides the real exception message behind a generic one", () => {
  const req = { requestId: "corr-4", method: "GET", url: "/x", originalUrl: "/api/v1/x" };
  const res = makeRes();
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    errorHandler(new Error("db connection refused at 10.0.0.5:27017"), req, res, () => {});
  } finally {
    process.env.NODE_ENV = originalEnv;
  }

  assert.equal(res.body.message, "Internal server error");
  assert.ok(!res.body.message.includes("10.0.0.5"), "the real connection detail must never reach the client");
});

test("errorHandler: real multer file-size/unexpected-file codes map to standard catalog codes", () => {
  const req = { requestId: "corr-5" };
  const tooLargeRes = makeRes();
  errorHandler({ code: "LIMIT_FILE_SIZE" }, req, tooLargeRes, () => {});
  assert.equal(tooLargeRes.statusCode, 413);
  assert.equal(tooLargeRes.body.data.code, "FILE_TOO_LARGE");

  const unexpectedRes = makeRes();
  errorHandler({ code: "LIMIT_UNEXPECTED_FILE" }, req, unexpectedRes, () => {});
  assert.equal(unexpectedRes.statusCode, 400);
  assert.equal(unexpectedRes.body.data.code, "UNEXPECTED_FILE_FIELD");
});

test("notFoundHandler produces the standard ROUTE_NOT_FOUND contract", () => {
  const req = { requestId: "corr-6", method: "GET", originalUrl: "/api/v1/does-not-exist" };
  const res = makeRes();
  notFoundHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.data.code, "ROUTE_NOT_FOUND");
  assert.ok(res.body.message.includes("/api/v1/does-not-exist"));
});
