import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Agent Performance Reporting (gap-audit "Gap E") — same direct-controller-
// call convention as tests/agentPortal.test.js, reusing its exact
// commission-crediting fixture pattern. Covers: revenue/booking-count
// ranking sorted descending, real commission-earned totals (not every
// wallet Credit — only type:"CommissionEarned"), an agent with zero
// bookings still appearing at 0 (never silently dropped), and the
// permission gate.

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

const waitFor = async (predicate, { timeoutMs = 20000, intervalMs = 50 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
};

test("Agent Performance Report: revenue/booking-count ranking, commission-earned totals, zero-booking agent included, permission gate", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const agentCtrl = await import("../controllers/AgentPortalController.js");
  const AgentCommissionService = (await import("../services/AgentCommissionService.js")).default;
  AgentCommissionService.initEventListeners();
  const AgentModel = (await import("../models/AgentModel.js")).default;
  const AgentWalletModel = (await import("../models/AgentWalletModel.js")).default;
  const AgentWalletTransactionModel = (await import("../models/AgentWalletTransactionModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CommissionRuleModel = (await import("../models/CommissionRuleModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-agent-perf-${suffix}`;

  const cleanupModels = [AgentModel, AgentWalletModel, AgentWalletTransactionModel, BookingHeaderModel, CustomerModel, CommissionRuleModel, NumberingSchemeModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
  });

  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Booking", prefix: "BK", isDefault: true }, "tester");
  await CommissionRuleModel.create({ tenantId, scope: "Global", type: "Percentage", value: 10, active: true });

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await agentCtrl.getAgentPerformanceReport({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, query: {} }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- Two agents: A books twice (higher revenue), B books once, C books never ----
  const createA = makeRes();
  await agentCtrl.createAgent({ auth: authAdmin(tenantId), body: { name: "Agent A", email: `perf-a.${suffix}@example.com`, password: "P@ssw0rd1" } }, createA);
  const agentAId = createA.body.data._id.toString();

  const createB = makeRes();
  await agentCtrl.createAgent({ auth: authAdmin(tenantId), body: { name: "Agent B", email: `perf-b.${suffix}@example.com`, password: "P@ssw0rd1" } }, createB);
  const agentBId = createB.body.data._id.toString();

  const createC = makeRes();
  await agentCtrl.createAgent({ auth: authAdmin(tenantId), body: { name: "Agent C (no bookings)", email: `perf-c.${suffix}@example.com`, password: "P@ssw0rd1" } }, createC);
  const agentCId = createC.body.data._id.toString();

  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "Perf", lastName: "Test", email: `perftest.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });

  await agentCtrl.createMyBooking({ agent: { agentId: agentAId, tenantId }, requestId: "r1", body: { customerId: customer._id.toString(), totalAmount: 1000, currency: "USD" } }, makeRes());
  await agentCtrl.createMyBooking({ agent: { agentId: agentAId, tenantId }, requestId: "r2", body: { customerId: customer._id.toString(), totalAmount: 500, currency: "USD" } }, makeRes());
  await agentCtrl.createMyBooking({ agent: { agentId: agentBId, tenantId }, requestId: "r3", body: { customerId: customer._id.toString(), totalAmount: 300, currency: "USD" } }, makeRes());

  // Real commission crediting is async off BookingCreated — wait for all 3 to land.
  await waitFor(async () => (await AgentWalletTransactionModel.countDocuments({ tenantId })) >= 3);

  const reportRes = makeRes();
  await agentCtrl.getAgentPerformanceReport({ auth: authAdmin(tenantId), query: {} }, reportRes);
  assert.equal(reportRes.statusCode, 200, JSON.stringify(reportRes.body));

  const rows = reportRes.body.data.items;
  assert.equal(rows.length, 3, "an agent with zero bookings must still appear in the report, not be silently dropped");

  const byId = Object.fromEntries(rows.map((r) => [r.agentId, r]));
  assert.equal(byId[agentAId].bookingCount, 2);
  assert.equal(byId[agentAId].revenue, 1500);
  assert.equal(byId[agentAId].commissionEarned, 150, "10% of 1500 total revenue");
  assert.equal(byId[agentBId].bookingCount, 1);
  assert.equal(byId[agentBId].revenue, 300);
  assert.equal(byId[agentCId].bookingCount, 0);
  assert.equal(byId[agentCId].revenue, 0);
  assert.equal(byId[agentCId].commissionEarned, 0);

  // ---- Ranked by revenue descending ----
  assert.equal(rows[0].agentId, agentAId, "the highest-revenue agent must be ranked first");

  // ---- Totals roll up correctly ----
  assert.equal(reportRes.body.data.totals.agentCount, 3);
  assert.equal(reportRes.body.data.totals.totalBookings, 3);
  assert.equal(reportRes.body.data.totals.totalRevenue, 1800);
  assert.equal(reportRes.body.data.totals.totalCommissionEarned, 180);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
