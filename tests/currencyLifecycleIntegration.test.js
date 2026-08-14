import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Finance Module Part 19 Part 2 (Multi-Currency & FX API Contracts
// Refactoring) — proves the real Currency seven-state lifecycle and the
// real Exchange Rate versioning/supersession/provider-priority behavior
// end to end against a real database.
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

test("CurrencyService: createCurrency auto-walks Draft->Pending Approval->Approved->Active with isoNumericCode/currencyType/reportingCurrency", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `cur-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => { await CurrencyModel.deleteMany({ tenantId }); });

  const currency = await CurrencyService.createCurrency({ currencyCode: "USD", currencyType: "Reporting", reportingCurrency: true }, tenantId, "tester");
  assert.equal(currency.status, "Active");
  assert.equal(currency.isoNumericCode, "840");
  assert.equal(currency.currencyType, "Reporting");
  assert.equal(currency.isReportingCurrency, true);
  assert.equal(currency.version, 4); // create + submit + approve + activate

  const timelineEvents = currency.timeline.map((t2) => t2.event);
  assert.deepEqual(timelineEvents, ["CurrencyCreated", "CurrencySubmittedForApproval", "CurrencyApproved", "CurrencyActivated"]);

  await assert.rejects(
    CurrencyService.createCurrency({ currencyCode: "EUR", isoNumericCode: "999" }, tenantId, "tester"),
    /Invalid ISO numeric code/
  );
});

test("CurrencyService: gated Currency lifecycle when CURRENCY_APPROVAL_REQUIRED is true", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `curgate-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const original = process.env.CURRENCY_APPROVAL_REQUIRED;
  process.env.CURRENCY_APPROVAL_REQUIRED = "true";

  t.after(async () => {
    await CurrencyModel.deleteMany({ tenantId });
    if (original === undefined) delete process.env.CURRENCY_APPROVAL_REQUIRED; else process.env.CURRENCY_APPROVAL_REQUIRED = original;
  });

  const currency = await CurrencyService.createCurrency({ currencyCode: "GBP" }, tenantId, "tester");
  assert.equal(currency.status, "Draft");

  await assert.rejects(CurrencyService.approveCurrencyDefinition(currency._id, tenantId, "tester"), /Cannot approve/);
  await assert.rejects(CurrencyService.activateCurrency(currency._id, tenantId, "tester"), /Cannot activate/);

  const submitted = await CurrencyService.submitCurrencyForApproval(currency._id, tenantId, "tester");
  assert.equal(submitted.status, "Pending Approval");

  const approved = await CurrencyService.approveCurrencyDefinition(currency._id, tenantId, "tester");
  assert.equal(approved.status, "Approved");

  const activated = await CurrencyService.activateCurrency(currency._id, tenantId, "tester");
  assert.equal(activated.status, "Active");

  const deprecated = await CurrencyService.deprecateCurrency(currency._id, tenantId, "tester");
  assert.equal(deprecated.status, "Deprecated");
  await assert.rejects(CurrencyService.activateCurrency(currency._id, tenantId, "tester"), /Cannot activate/);
});

test("CurrencyService: exchange rate versioning, auto-supersede, and approval gating", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `rate-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => { await ExchangeRateModel.deleteMany({ tenantId }); });

  const first = await CurrencyService.createExchangeRate({ fromCurrency: "USD", toCurrency: "PKR", rate: 280, effectiveDate: "2027-01-01" }, tenantId, "tester");
  assert.equal(first.version, 1);
  assert.equal(first.approvalStatus, "Activated");

  const second = await CurrencyService.createExchangeRate({ fromCurrency: "USD", toCurrency: "PKR", rate: 285, effectiveDate: "2027-02-01" }, tenantId, "tester");
  assert.equal(second.version, 2);
  assert.equal(second.supersedes.toString(), first._id.toString());

  const reloadedFirst = await ExchangeRateModel.findById(first._id).lean();
  assert.equal(reloadedFirst.approvalStatus, "Superseded");
  assert.equal(reloadedFirst.supersededBy.toString(), second._id.toString());

  const resolved = await CurrencyService.getRate(tenantId, "USD", "PKR", { asOfDate: "2027-03-01" });
  assert.equal(resolved.rate, 285);
  assert.equal(resolved.rateId.toString(), second._id.toString());

  // expiresAt validation
  await assert.rejects(
    CurrencyService.createExchangeRate({ fromCurrency: "USD", toCurrency: "AED", rate: 3.67, effectiveDate: "2027-01-01", expiresAt: "2026-12-31" }, tenantId, "tester"),
    /expiresAt must be after effectiveDate/
  );
});

test("CurrencyService: approval-gated exchange rate never resolves for conversion until approved", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `rategate-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const original = process.env.EXCHANGE_RATE_APPROVAL_REQUIRED;
  process.env.EXCHANGE_RATE_APPROVAL_REQUIRED = "true";

  t.after(async () => {
    await ExchangeRateModel.deleteMany({ tenantId });
    if (original === undefined) delete process.env.EXCHANGE_RATE_APPROVAL_REQUIRED; else process.env.EXCHANGE_RATE_APPROVAL_REQUIRED = original;
  });

  const rate = await CurrencyService.createExchangeRate({ fromCurrency: "USD", toCurrency: "SAR", rate: 3.75, effectiveDate: "2027-01-01" }, tenantId, "tester");
  assert.equal(rate.approvalStatus, "Pending Approval");

  await assert.rejects(CurrencyService.getRate(tenantId, "USD", "SAR", { asOfDate: "2027-01-15" }), /No exchange rate available/);

  const approved = await CurrencyService.approveExchangeRate(rate._id, tenantId, "tester");
  assert.equal(approved.approvalStatus, "Activated");

  const resolved = await CurrencyService.getRate(tenantId, "USD", "SAR", { asOfDate: "2027-01-15" });
  assert.equal(resolved.rate, 3.75);
});

test("CurrencyService: provider priority breaks ties on the exact same effectiveDate", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `prio-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  t.after(async () => { await ExchangeRateModel.deleteMany({ tenantId }); });

  // Insert two independently-Activated rows for the same pair/date/type
  // from different providers directly (bypassing the supersede path) to
  // prove tie-breaking, not supersession, is what's being exercised.
  await ExchangeRateModel.create({ tenantId, fromCurrency: "EUR", toCurrency: "USD", rate: 1.10, rateType: "Spot", provider: "OpenExchangeAPI", source: "Automatic", effectiveDate: new Date("2027-04-01"), version: 1, approvalStatus: "Activated" });
  await ExchangeRateModel.create({ tenantId, fromCurrency: "EUR", toCurrency: "USD", rate: 1.12, rateType: "Spot", provider: "CentralBank", source: "Manual", effectiveDate: new Date("2027-04-01"), version: 1, approvalStatus: "Activated" });

  const resolved = await CurrencyService.getRate(tenantId, "EUR", "USD", { asOfDate: "2027-04-02" });
  // CentralBank is earlier than OpenExchangeAPI in the default rateProviderPriority.
  assert.equal(resolved.rate, 1.12);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
