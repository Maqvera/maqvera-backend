import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Finance Module Part 19 Part 3 (Conversion Engine, FX Accounting &
// Revaluation) — proves the real Conversion Engine end to end against a
// real database: TreasuryService no longer fabricates a 1.0 rate, the
// Conversion Audit Trail is genuinely opt-in, rate-type "auto" priority
// resolution works, Realized FX Gain/Loss posts at AR settlement, and a
// posted Journal denormalizes the resolved rate's provider/version.
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

const makeCustomer = async (CustomerModel, tenantId, suffix) => CustomerModel.create({
  tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: `Customer${suffix}`,
  email: `test-${suffix}@example.com`, phone: "+10000000000"
});

const setupUsdEur = async (CurrencyService, tenantId) => {
  await CurrencyService.createCurrency({ currencyCode: "USD", baseCurrency: true }, tenantId, "tester");
  await CurrencyService.createCurrency({ currencyCode: "EUR" }, tenantId, "tester");
};

test("CurrencyService.convert: Conversion Audit Trail is real but opt-in (source supplied vs not)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyConversionModel = (await import("../models/CurrencyConversionModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `conv-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
    await CurrencyConversionModel.deleteMany({ tenantId });
  });

  await setupUsdEur(CurrencyService, tenantId);
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.1, effectiveDate: "2026-01-01" }, tenantId, "tester");

  const beforeCount = await CurrencyConversionModel.countDocuments({ tenantId });

  const withoutSource = await CurrencyService.convert(100, "EUR", "USD", tenantId);
  assert.equal(withoutSource.conversionId, undefined);
  assert.equal(await CurrencyConversionModel.countDocuments({ tenantId }), beforeCount);

  const withSource = await CurrencyService.convert(100, "EUR", "USD", tenantId, { source: "Journal Entry", sourceReferenceId: "JE-TEST-1" });
  assert.ok(withSource.conversionId);
  assert.equal(await CurrencyConversionModel.countDocuments({ tenantId }), beforeCount + 1);

  const row = await CurrencyConversionModel.findById(withSource.conversionId).lean();
  assert.equal(row.conversionSource, "Journal Entry");
  assert.equal(row.originalCurrency, "EUR");
  assert.equal(row.convertedCurrency, "USD");
  assert.equal(row.calculationMethod, "Direct");
  assert.equal(row.rate, 1.1);
});

test("CurrencyService.getRate rateType 'auto' tries rateTypePriority order (Negotiated before Spot by default)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `auto-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
  });

  await setupUsdEur(CurrencyService, tenantId);
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.1, rateType: "Spot", effectiveDate: "2026-01-01" }, tenantId, "tester");
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.15, rateType: "Negotiated", effectiveDate: "2026-01-01" }, tenantId, "tester");

  const result = await CurrencyService.getRate(tenantId, "EUR", "USD", { rateType: "auto" });
  assert.equal(result.rateType, "Negotiated");
  assert.equal(result.rate, 1.15);
  assert.ok(result.rateProvider);
  assert.equal(result.rateVersion, 1);
});

test("AccountsReceivableService.allocatePayment posts Realized FX Gain when the settlement rate is higher than the booking rate", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const PaymentModel = (await import("../models/PaymentModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;
  const AccountsReceivableService = (await import("../services/AccountsReceivableService.js")).default;
  const PaymentService = (await import("../services/PaymentService.js")).default;

  const suffix = `fxgl-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
    await CustomerModel.deleteMany({ tenantId });
    await AccountsReceivableModel.deleteMany({ tenantId });
    await PaymentModel.deleteMany({ tenantId });
  });

  await setupUsdEur(CurrencyService, tenantId);
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.1, effectiveDate: "2026-01-01" }, tenantId, "tester");

  const customer = await makeCustomer(CustomerModel, tenantId, suffix);

  const receivable = await AccountsReceivableService.createReceivable({
    customerId: customer._id, invoiceNumber: `INV-${suffix}`, issueDate: "2026-01-05", dueDate: "2026-09-05", originalAmount: 1000, currency: "EUR"
  }, tenantId, "tester");
  assert.equal(receivable.bookingExchangeRate, 1.1);
  assert.equal(receivable.bookingBaseCurrency, "USD");
  assert.equal(receivable.bookingBaseCurrencyAmount, 1100);

  // Settlement-time rate rose from 1.10 to 1.20 — a real EUR receivable
  // (asset) becoming worth MORE base currency is a real Realized Gain.
  // Settlement itself happens "now" (allocatePayment resolves the
  // settlement-time rate via the real Conversion Engine's own default
  // "as of today" lookup, not this effectiveDate) — this just needs to be
  // the latest qualifying rate as of today.
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.2, effectiveDate: "2026-02-01" }, tenantId, "tester");

  const payment = await PaymentService.createPayment({
    paymentType: "Customer", partyType: "customer", partyId: customer._id, amount: 1000, currency: "EUR", paymentMethod: "Cash"
  }, tenantId, "tester");
  assert.equal(payment.status, "Captured");

  const result = await AccountsReceivableService.allocatePayment(receivable._id, { paymentId: payment._id, amount: 1000 }, tenantId, "tester");

  assert.ok(result.realizedFx, "expected a real Realized FX Gain/Loss to be computed");
  assert.equal(result.realizedFx.type, "Realized Gain");
  assert.equal(result.realizedFx.amount, 100); // 1000*1.20 - 1000*1.10

  const updated = await AccountsReceivableModel.findById(receivable._id).lean();
  assert.equal(updated.status, "Paid");
  assert.ok(updated.timeline.some((e) => e.event === "RealizedGain"));
});

test("JournalService.createJournal denormalizes the resolved rate's provider and version onto the posted journal", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const JournalModel = (await import("../models/JournalModel.js")).default;
  const ChartOfAccountModel = (await import("../models/ChartOfAccountModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;
  const JournalService = (await import("../services/JournalService.js")).default;
  const ChartOfAccountService = (await import("../services/ChartOfAccountService.js")).default;

  const suffix = `jrnl-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
    await JournalModel.deleteMany({ tenantId });
    await ChartOfAccountModel.deleteMany({ tenantId });
  });

  await setupUsdEur(CurrencyService, tenantId);
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.1, effectiveDate: "2026-01-01" }, tenantId, "tester");

  const debitAccount = await ChartOfAccountService.createAccount({ accountCode: `${suffix}-1000`, name: "Test Debit Account", category: "Assets" }, tenantId, "tester");
  const creditAccount = await ChartOfAccountService.createAccount({ accountCode: `${suffix}-2000`, name: "Test Credit Account", category: "Liabilities" }, tenantId, "tester");

  const journal = await JournalService.createJournal({
    journalType: "Manual", postingDate: "2026-01-10", description: "Rate provenance test", currency: "EUR",
    lines: [{ accountCode: debitAccount.accountCode, debit: 100 }, { accountCode: creditAccount.accountCode, credit: 100 }]
  }, tenantId, "tester");

  assert.equal(journal.exchangeRate, 1.1);
  assert.ok(journal.exchangeRateProvider, "expected exchangeRateProvider to be denormalized onto the journal");
  assert.equal(journal.exchangeRateVersion, 1);
});

test("TreasuryService.calculateFXExposure resolves a real exchange rate instead of a hardcoded 1.0", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const TreasuryInvestmentModel = (await import("../models/TreasuryInvestmentModel.js")).default;
  const TreasuryFXExposureModel = (await import("../models/TreasuryFXExposureModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;
  const TreasuryService = (await import("../services/TreasuryService.js")).default;

  const suffix = `fxexp-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
    await TreasuryInvestmentModel.deleteMany({ tenantId });
    await TreasuryFXExposureModel.deleteMany({ tenantId });
  });

  await setupUsdEur(CurrencyService, tenantId);
  await CurrencyService.createExchangeRate({ fromCurrency: "EUR", toCurrency: "USD", rate: 1.25, effectiveDate: "2026-01-01" }, tenantId, "tester");

  await TreasuryInvestmentModel.create({
    tenantId, investmentId: `TINV-${suffix}`, name: "Test EUR Investment", investmentType: "FixedDeposit",
    counterpartyBank: "Test Bank", currency: "EUR", principalAmount: 1000, currentValue: 1000, interestRate: 2,
    startDate: "2026-01-01", maturityDate: "2027-01-01", status: "Active"
  });

  const result = await TreasuryService.calculateFXExposure({ tenantId, baseCurrency: "USD", userId: "tester" });
  const eurExposure = result.find((e) => e.currency === "EUR") || (await TreasuryFXExposureModel.findOne({ tenantId, currency: "EUR" }).lean());

  assert.ok(eurExposure, "expected an EUR FX exposure row to be computed");
  assert.equal(eurExposure.exchangeRate, 1.25);
  assert.notEqual(eurExposure.exchangeRate, 1);
  assert.equal(eurExposure.baseCurrencyValue, 1250);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
