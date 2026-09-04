import test from "node:test";
import assert from "node:assert/strict";
import { maskSensitiveColumns } from "../utils/reportColumnSecurity.js";
import ReportExportService from "../services/ReportExportService.js";

test("maskSensitiveColumns — is a no-op when no permissions context is supplied (backward-compatible default for every pre-existing export call site)", () => {
  const rows = [{ name: "Ali", passportNumber: "AB1234567" }];
  const result = maskSensitiveColumns(rows);
  assert.equal(result[0].passportNumber, "AB1234567");
});

test("maskSensitiveColumns — masks a sensitive field when the caller lacks the required permission", () => {
  const rows = [{ name: "Ali", passportNumber: "AB1234567", nationalId: "12345-6789012-3" }];
  const result = maskSensitiveColumns(rows, ["customer.read"]);
  assert.equal(result[0].passportNumber, "***");
  assert.equal(result[0].nationalId, "***");
  assert.equal(result[0].name, "Ali", "non-sensitive fields must be untouched");
});

test("maskSensitiveColumns — leaves a sensitive field visible when the caller holds the required permission", () => {
  const rows = [{ name: "Ali", passportNumber: "AB1234567" }];
  const result = maskSensitiveColumns(rows, ["visa.passports.read"]);
  assert.equal(result[0].passportNumber, "AB1234567");
});

test("maskSensitiveColumns — admin always sees everything", () => {
  const rows = [{ bankAccountNumber: "0012345678" }];
  const result = maskSensitiveColumns(rows, ["admin"]);
  assert.equal(result[0].bankAccountNumber, "0012345678");
});

test("maskSensitiveColumns — a row with no sensitive fields at all is returned untouched (not even copied)", () => {
  const row = { region: "North", openBookings: 12 };
  const [result] = maskSensitiveColumns([row], ["customer.read"]);
  assert.equal(result, row, "should be the exact same object reference — nothing to mask");
});

test("ReportExportService.generateCsv — end-to-end: a caller without the required permission gets a masked export", () => {
  const report = { reportType: "VendorPaymentReport", data: { rows: [{ vendorName: "Acme", bankAccountNumber: "0099887766" }] }, _id: "R1" };

  const unmasked = ReportExportService.generateCsv(report, { permissions: ["finance.bankaccount.read"] });
  assert.match(unmasked.content, /0099887766/);

  const masked = ReportExportService.generateCsv(report, { permissions: ["finance.read"] });
  assert.doesNotMatch(masked.content, /0099887766/);
  assert.match(masked.content, /\*\*\*/);
});
