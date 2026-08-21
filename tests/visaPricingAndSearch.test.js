import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Visa Module PRD §7 (search) + §8/§12 (pricing) gap-closing tests.

// Pure function — no DB required.
test("calculateVisaSellingPrice: Vendor Cost + Government Fee + Insurance + Service Charges + Other Charges - Discount = Selling Price", async () => {
  const { calculateVisaSellingPrice } = await import("../services/VisaRequirementService.js");

  assert.equal(calculateVisaSellingPrice({ vendorCost: 100, governmentFee: 50, insuranceFee: 20, serviceCharges: 30, otherCharges: 10, discount: 15 }), 195);
  assert.equal(calculateVisaSellingPrice({}), 0);
  // Never goes negative even if discount exceeds the sum of charges.
  assert.equal(calculateVisaSellingPrice({ vendorCost: 10, discount: 100 }), 0);
});

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

test("VisaService.updateApplicationPricing computes sellingPrice server-side and publishes VISA_CASE_INVOICED only on the 0->positive transition", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const VisaService = (await import("../services/VisaService.js")).default;
  const { subscribeEvent } = await import("../utils/eventBus.js");
  const { VISA_DOMAIN_EVENTS } = await import("../utils/visaConstants.js");

  const suffix = `pricing-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await Promise.all([CustomerModel.deleteMany({ tenantId }), VisaCaseModel.deleteMany({ tenantId })]);
  });

  const traveler = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: "Traveler",
    email: `${suffix}@example.com`, phone: "+10000000000"
  });
  const visaCase = await VisaCaseModel.create({
    tenantId, caseNumber: `VIS-${suffix}`, travelerId: traveler._id,
    travelerSnapshot: { firstName: "Test", lastName: "Traveler", fullName: "Test Traveler", phone: "+19998887777" },
    destinationCountry: "Testland", visaType: "tourist_visa",
    applications: [{ applicationNumber: `VIS-${suffix}-APP-1`, visaType: "tourist_visa", status: "draft" }]
  });
  const applicationNumber = visaCase.applications[0].applicationNumber;

  let invoicedEvents = 0;
  subscribeEvent(VISA_DOMAIN_EVENTS.VISA_CASE_INVOICED, (payload) => {
    if (payload.visaCaseId === visaCase._id.toString()) invoicedEvents += 1;
  });

  const priced = await VisaService.updateApplicationPricing(visaCase._id.toString(), applicationNumber, {
    vendorCost: 100, governmentFee: 50, insuranceFee: 0, serviceCharges: 20, otherCharges: 0, discount: 10
  }, tenantId, "tester");

  const pricedApp = priced.applications.find((a) => a.applicationNumber === applicationNumber);
  assert.equal(pricedApp.sellingPrice, 160);
  assert.equal(pricedApp.feeAmount, 160);

  // Re-pricing an already-priced application (positive -> positive) must
  // not re-fire VISA_CASE_INVOICED — it already fired once.
  await VisaService.updateApplicationPricing(visaCase._id.toString(), applicationNumber, {
    vendorCost: 200
  }, tenantId, "tester");

  // Event dispatch is queueMicrotask-based (utils/eventBus.js) — flush the
  // microtask queue before asserting the listener ran.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invoicedEvents, 1, "VISA_CASE_INVOICED must fire exactly once, only on the 0->positive transition");
});

test("VisaService.getVisaCases search matches traveler mobile number", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const VisaService = (await import("../services/VisaService.js")).default;

  const suffix = `search-${Date.now()}`;
  const tenantId = `test-${suffix}`;
  t.after(async () => {
    await Promise.all([CustomerModel.deleteMany({ tenantId }), VisaCaseModel.deleteMany({ tenantId })]);
  });

  const traveler = await CustomerModel.create({
    tenantId, customerCode: `CUST-${suffix}`, firstName: "Test", lastName: "Traveler",
    email: `${suffix}@example.com`, phone: "+10000000000"
  });
  const uniquePhone = "+19995551234";
  await VisaCaseModel.create({
    tenantId, caseNumber: `VIS-${suffix}`, travelerId: traveler._id,
    travelerSnapshot: { firstName: "Test", lastName: "Traveler", fullName: "Test Traveler", phone: uniquePhone },
    destinationCountry: "Testland", visaType: "tourist_visa"
  });

  const result = await VisaService.getVisaCases({ search: "9995551234" }, tenantId);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].travelerSnapshot.phone, uniquePhone);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
