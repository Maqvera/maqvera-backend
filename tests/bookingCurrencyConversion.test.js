import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Multi-currency booking balance — multi-currency-booking-and-statement-
// requirements.md §3/§4. CreateBooking must persist a real, server-computed
// convertedAmount/convertedCurrency/conversionRate when the caller supplies
// convertedCurrency, and must stay fully backward compatible (all five
// fields null) when it isn't supplied at all.

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
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const authFor = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin", "bookings.create", "booking.create"] });

test("CreateBooking with convertedCurrency persists a real server-computed conversion matching CurrencyService.convert", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { CreateBooking } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CurrencyModel = (await import("../models/CurrencyModel.js")).default;
  const ExchangeRateModel = (await import("../models/ExchangeRateModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const ResourceSequenceModel = (await import("../models/ResourceSequenceModel.js")).default;
  const GeneratedNumberModel = (await import("../models/GeneratedNumberModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;
  const CurrencyService = (await import("../services/CurrencyService.js")).default;

  const suffix = `bkconv-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await Promise.all([
      BookingHeaderModel.deleteMany({ tenantId }),
      CustomerModel.deleteMany({ tenantId }),
      CurrencyModel.deleteMany({ tenantId }),
      ExchangeRateModel.deleteMany({ tenantId }),
      NumberingSchemeModel.deleteMany({ tenantId }),
      ResourceSequenceModel.deleteMany({ tenantId }),
      GeneratedNumberModel.deleteMany({ tenantId })
    ]);
  });

  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: "Customer",
    email: `${suffix}@example.com`, phone: "+10000000000"
  });
  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Booking", prefix: "BK", includeYear: true, sequenceLength: 6, isDefault: true }, "tester");
  await CurrencyService.createCurrency({ currencyCode: "USD", baseCurrency: true }, tenantId, "tester");
  await CurrencyService.createCurrency({ currencyCode: "SAR" }, tenantId, "tester");
  await CurrencyService.createExchangeRate({ fromCurrency: "USD", toCurrency: "SAR", rate: 3.75, effectiveDate: "2026-01-01" }, tenantId, "tester");

  const expectedConversion = await CurrencyService.convert(1000, "usd", "SAR", tenantId);

  const req = {
    auth: authFor(tenantId),
    body: { customerId: customer._id.toString(), currencyId: "usd", totalAmount: 1000, convertedCurrency: "SAR" },
    requestId: `req-${Math.random()}`
  };
  const res = makeRes();
  await CreateBooking(req, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const stored = await BookingHeaderModel.findOne({ tenantId }).lean();
  assert.equal(stored.financialSnapshot.convertedAmount, expectedConversion.convertedAmount);
  assert.equal(stored.financialSnapshot.convertedCurrency, "SAR");
  assert.equal(stored.financialSnapshot.conversionRate, expectedConversion.rate);
  assert.ok(stored.financialSnapshot.conversionAsOf);
});

test("CreateBooking without convertedCurrency leaves financialSnapshot.convertedAmount null (backward compatible)", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const { CreateBooking } = await import("../controllers/BookingController.js");
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const ResourceSequenceModel = (await import("../models/ResourceSequenceModel.js")).default;
  const GeneratedNumberModel = (await import("../models/GeneratedNumberModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;

  const suffix = `bknoconv-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await Promise.all([
      BookingHeaderModel.deleteMany({ tenantId }),
      CustomerModel.deleteMany({ tenantId }),
      NumberingSchemeModel.deleteMany({ tenantId }),
      ResourceSequenceModel.deleteMany({ tenantId }),
      GeneratedNumberModel.deleteMany({ tenantId })
    ]);
  });

  const customer = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: "Customer",
    email: `${suffix}@example.com`, phone: "+10000000000"
  });
  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Booking", prefix: "BK", includeYear: true, sequenceLength: 6, isDefault: true }, "tester");

  const req = {
    auth: authFor(tenantId),
    body: { customerId: customer._id.toString(), totalAmount: 500 },
    requestId: `req-${Math.random()}`
  };
  const res = makeRes();
  await CreateBooking(req, res);

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const stored = await BookingHeaderModel.findOne({ tenantId }).lean();
  assert.equal(stored.financialSnapshot.convertedAmount, null);
  assert.equal(stored.financialSnapshot.convertedCurrency, null);
  assert.equal(stored.financialSnapshot.conversionRate, null);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
