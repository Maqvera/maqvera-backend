import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Controller/HTTP-level coverage for the Owner Dashboard (PRD "CRM Feature
// Map by Phase" Phase 1 module 2) — same direct-controller-call convention
// as tests/packagePricingController.test.js / tests/visaDashboardAnalytics.test.js
// (no supertest, live MongoDB).

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

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });
const authNoPerm = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: [] });

test("Owner Dashboard controller: overview aggregates bookings/customers/visas/payments correctly, tenant-scoped, permission-gated", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/OwnerDashboardController.js");
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const VisaCaseModel = (await import("../models/VisaCaseModel.js")).default;
  const PaymentModel = (await import("../models/PaymentModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-owner-dash-${suffix}`;
  const dummyPackageId = new mongoose.Types.ObjectId();

  const cleanupModels = [CustomerModel, BookingHeaderModel, VisaCaseModel, PaymentModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
  });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const withinMonth = new Date(monthStart.getTime() + 60 * 60 * 1000);
  const longAgo = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1));

  const cust1 = await CustomerModel.create({ tenantId, customerCode: `CUST-A-${suffix}`, firstName: "A", lastName: "One", email: `a.${suffix}@example.com`, phone: `+1000${suffix}`.slice(0, 15) });
  const cust2 = await CustomerModel.create({ tenantId, customerCode: `CUST-B-${suffix}`, firstName: "B", lastName: "Two", email: `b.${suffix}@example.com`, phone: `+1001${suffix}`.slice(0, 15) });

  await BookingHeaderModel.create({ tenantId, bookingReference: `BK-A-${suffix}`, customerId: cust1._id, customerName: "A One", packageId: dummyPackageId, totalAmount: 500, currency: "USD", status: "confirmed", createdAt: now });
  await BookingHeaderModel.create({ tenantId, bookingReference: `BK-B-${suffix}`, customerId: cust2._id, customerName: "B Two", packageId: dummyPackageId, totalAmount: 300, currency: "USD", status: "reserved", createdAt: withinMonth });
  await BookingHeaderModel.create({ tenantId, bookingReference: `BK-C-${suffix}`, customerId: cust1._id, customerName: "A One", packageId: dummyPackageId, totalAmount: 999, currency: "USD", status: "completed", createdAt: longAgo });

  await VisaCaseModel.create({ tenantId, caseNumber: `VC-A-${suffix}`, travelerId: cust1._id, destinationCountry: "Saudi Arabia", status: "documents_pending" });
  await VisaCaseModel.create({ tenantId, caseNumber: `VC-B-${suffix}`, travelerId: cust2._id, destinationCountry: "Saudi Arabia", status: "embassy_processing" });
  await VisaCaseModel.create({ tenantId, caseNumber: `VC-C-${suffix}`, travelerId: cust1._id, destinationCountry: "Saudi Arabia", status: "completed" });

  await PaymentModel.create({ tenantId, paymentNumber: `PAY-A-${suffix}`, paymentType: "Customer", partyType: "customer", partyId: cust1._id, amount: 500, currency: "USD", paymentMethod: "Cash", gateway: "Manual", status: "Captured", unallocatedAmount: 0, transactionDate: now });
  await PaymentModel.create({ tenantId, paymentNumber: `PAY-B-${suffix}`, paymentType: "Customer", partyType: "customer", partyId: cust2._id, amount: 300, currency: "USD", paymentMethod: "Cash", gateway: "Manual", status: "Captured", unallocatedAmount: 0, transactionDate: now });

  // ---- Tenant context required ----
  const noScopeRes = makeRes();
  await ctrl.getOwnerDashboardOverview({ auth: {} }, noScopeRes);
  assert.equal(noScopeRes.statusCode, 403);

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.getOwnerDashboardOverview({ auth: authNoPerm(tenantId) }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Happy path ----
  const res = makeRes();
  await ctrl.getOwnerDashboardOverview({ auth: authAdmin(tenantId) }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const data = res.body.data;

  assert.equal(data.totalCustomers, 2);
  assert.equal(data.bookingsThisMonth, 2, "only the two bookings created within the current month must count");
  assert.equal(data.pendingVisasCount, 2, "the completed visa case must be excluded as terminal");

  assert.equal(data.recentBookings.length, 3);
  assert.equal(data.recentBookings[0].bookingReference, `BK-A-${suffix}`, "most recent booking must be first");
  assert.equal(data.recentBookings[0].packageName, null, "a booking referencing a non-existent package must resolve packageName to null, never throw");

  assert.equal(data.recentPayments.length, 2);

  const breakdown = data.packageSalesBreakdown.find((p) => p.packageId?.toString() === dummyPackageId.toString());
  assert.ok(breakdown, "package sales breakdown must include the dummy package");
  assert.equal(breakdown.bookingCount, 2, "only this-month bookings count toward the breakdown");
  assert.equal(breakdown.revenue, 800);

  assert.equal(data.revenueThisMonth, 0, "a tenant with no Chart of Accounts/journal postings must honestly report 0, not throw or fabricate");
  assert.equal(data.profitThisMonth, 0);

  assert.equal(data.monthlyBookingsChart.length, 12);
  assert.equal(data.monthlyBookingsChart[11].count, 2, "the current (last) month bucket must reflect the two in-month bookings");

  assert.equal(data.revenueTrendChart.length, 12);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
