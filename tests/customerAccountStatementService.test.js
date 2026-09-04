import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Multi-currency statement fix — multi-currency-booking-and-statement-
// requirements.md §1/§2. Proves: (a) single-currency statements are
// byte-for-byte unchanged, (b) mixed-currency statements no longer silently
// sum raw amounts across currencies, and (c) an explicit viewCurrency
// converts every row, not just the totals.
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
  email: `stmt-${suffix}@example.com`, phone: "+10000000000"
});

const makeReceivable = async (AccountsReceivableModel, { tenantId, customerId, customerName, invoiceNumber, amount, currency }) => AccountsReceivableModel.create({
  tenantId, customerId, customerName, invoiceNumber,
  issueDate: new Date("2026-01-01"), dueDate: new Date("2026-02-01"),
  originalAmount: amount, paidAmount: 0, outstandingBalance: amount,
  currency, status: "Open"
});

test("CustomerAccountStatementService.getStatement: single-currency receivables sum raw, unchanged from before the fix", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const CustomerAccountStatementService = (await import("../services/CustomerAccountStatementService.js")).default;

  const suffix = `single-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const customer = await makeCustomer(CustomerModel, tenantId, suffix);
  t.after(async () => {
    await CustomerModel.deleteMany({ tenantId });
    await AccountsReceivableModel.deleteMany({ tenantId });
  });

  await makeReceivable(AccountsReceivableModel, { tenantId, customerId: customer._id, customerName: "Test Customer", invoiceNumber: `INV-${suffix}-1`, amount: 500, currency: "USD" });
  await makeReceivable(AccountsReceivableModel, { tenantId, customerId: customer._id, customerName: "Test Customer", invoiceNumber: `INV-${suffix}-2`, amount: 300, currency: "USD" });

  const statement = await CustomerAccountStatementService.getStatement(customer._id.toString(), tenantId, {});

  assert.equal(statement.totals.totalDebit, 800);
  assert.equal(statement.totals.totalBalance, 800);
  assert.equal(statement.totals.currency, "USD");
  assert.equal(statement.rows[0].currency, "USD");
  assert.equal(statement.rows[0].originalCurrency, "USD");
});

test("CustomerAccountStatementService.getStatement: mixed currencies with no viewCurrency convert into the tenant base currency instead of raw-summing", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;
  const CustomerAccountStatementService = (await import("../services/CustomerAccountStatementService.js")).default;

  const suffix = `mixed-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const customer = await makeCustomer(CustomerModel, tenantId, suffix);
  t.after(async () => {
    await CustomerModel.deleteMany({ tenantId });
    await AccountsReceivableModel.deleteMany({ tenantId });
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
  });

  await CurrencyService.createCurrency({ currencyCode: "USD", baseCurrency: true }, tenantId, "tester");
  await CurrencyService.createCurrency({ currencyCode: "PKR" }, tenantId, "tester");
  await CurrencyService.createExchangeRate({ fromCurrency: "PKR", toCurrency: "USD", rate: 0.0036, effectiveDate: "2026-01-01" }, tenantId, "tester");

  await makeReceivable(AccountsReceivableModel, { tenantId, customerId: customer._id, customerName: "Test Customer", invoiceNumber: `INV-${suffix}-1`, amount: 500, currency: "USD" });
  await makeReceivable(AccountsReceivableModel, { tenantId, customerId: customer._id, customerName: "Test Customer", invoiceNumber: `INV-${suffix}-2`, amount: 50000, currency: "PKR" });

  const statement = await CustomerAccountStatementService.getStatement(customer._id.toString(), tenantId, {});

  assert.equal(statement.totals.currency, "USD");
  // Old buggy behavior would have been 500 + 50000 = 50500 (meaningless).
  assert.notEqual(statement.totals.totalDebit, 50500);
  assert.equal(statement.totals.totalDebit, 500 + 50000 * 0.0036);
  assert.equal(statement.rows.find((r) => r.originalCurrency === "PKR").currency, "PKR");
});

test("CustomerAccountStatementService.getStatement: viewCurrency converts every row's debit/credit/balance and preserves originalCurrency", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const AccountsReceivableModel = (await import("../models/AccountsReceivableModel.js")).default;
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;
  const CustomerAccountStatementService = (await import("../services/CustomerAccountStatementService.js")).default;

  const suffix = `view-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  const customer = await makeCustomer(CustomerModel, tenantId, suffix);
  t.after(async () => {
    await CustomerModel.deleteMany({ tenantId });
    await AccountsReceivableModel.deleteMany({ tenantId });
    await CurrencyModel.deleteMany({ tenantId });
    await ExchangeRateModel.deleteMany({ tenantId });
  });

  await CurrencyService.createCurrency({ currencyCode: "USD", baseCurrency: true }, tenantId, "tester");
  await CurrencyService.createCurrency({ currencyCode: "PKR" }, tenantId, "tester");
  await CurrencyService.createExchangeRate({ fromCurrency: "USD", toCurrency: "PKR", rate: 278, effectiveDate: "2026-01-01" }, tenantId, "tester");

  await makeReceivable(AccountsReceivableModel, { tenantId, customerId: customer._id, customerName: "Test Customer", invoiceNumber: `INV-${suffix}-1`, amount: 500, currency: "USD" });

  const statement = await CustomerAccountStatementService.getStatement(customer._id.toString(), tenantId, { viewCurrency: "pkr" });

  assert.equal(statement.viewCurrency, "PKR");
  assert.equal(statement.totals.currency, "PKR");
  assert.equal(statement.rows[0].currency, "PKR");
  assert.equal(statement.rows[0].originalCurrency, "USD");
  assert.equal(statement.rows[0].debit, 500 * 278);
  assert.equal(statement.totals.totalDebit, 500 * 278);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
