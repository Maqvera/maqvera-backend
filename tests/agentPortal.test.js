import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// B2B Agent Portal (PRD "CRM Feature Map by Phase" Phase 2 module 14) —
// same direct-controller-call convention as tests/bookingIsolation.test.js,
// covering: agent isolation (agent A never sees agent B's bookings/wallet),
// agent-side booking creation, and real commission crediting off a
// BookingCreated event.

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

const waitFor = async (predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
};

test("Agent Portal: staff create/list/permission gate, agent login, agent-initiated booking + real commission crediting, cross-agent isolation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const agentCtrl = await import("../controllers/AgentPortalController.js");
  const AgentCommissionService = (await import("../services/AgentCommissionService.js")).default;
  // initEventListeners is idempotent (matches every other *Service in this
  // codebase) — server.js's bootstrap never runs in a bare `node --test`
  // process, so the test must register the BookingCreated subscription itself.
  AgentCommissionService.initEventListeners();
  const AgentModel = (await import("../models/AgentModel.js")).default;
  const AgentWalletModel = (await import("../models/AgentWalletModel.js")).default;
  const AgentWalletTransactionModel = (await import("../models/AgentWalletTransactionModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const BookingWorkflowModel = (await import("../models/BookingWorkflowModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;
  const CommissionRuleModel = (await import("../models/CommissionRuleModel.js")).default;
  const NumberingSchemeModel = (await import("../models/NumberingSchemeModel.js")).default;
  const NumberGeneratorService = (await import("../services/NumberGeneratorService.js")).default;
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-agent-portal-${suffix}`;

  const cleanupModels = [AgentModel, AgentWalletModel, AgentWalletTransactionModel, BookingHeaderModel, BookingWorkflowModel, CustomerModel, CommissionRuleModel, NumberingSchemeModel];
  t.after(async () => {
    await Promise.all(cleanupModels.map((m) => m.deleteMany({ tenantId })));
    await AuditLogModel.deleteMany({ tenantId });
  });

  await NumberGeneratorService.createScheme(tenantId, { resourceType: "Booking", prefix: "BK", isDefault: true }, "tester");

  // ---- Staff-side: permission gate, create, duplicate email ----
  const noPermRes = makeRes();
  await agentCtrl.createAgent({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, body: { name: "X", email: `x.${suffix}@example.com`, password: "P@ssw0rd1" } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  const emailA = `agent-a.${suffix}@example.com`;
  const createARes = makeRes();
  await agentCtrl.createAgent({ auth: authAdmin(tenantId), body: { name: "Agent A", email: emailA, password: "P@ssw0rd1" } }, createARes);
  assert.equal(createARes.statusCode, 201, JSON.stringify(createARes.body));
  assert.equal(createARes.body.data.passwordHash, undefined, "the password hash must never be exposed");
  const agentAId = createARes.body.data._id.toString();

  const dupRes = makeRes();
  await agentCtrl.createAgent({ auth: authAdmin(tenantId), body: { name: "Dup", email: emailA, password: "P@ssw0rd1" } }, dupRes);
  assert.equal(dupRes.statusCode, 409);

  const emailB = `agent-b.${suffix}@example.com`;
  const createBRes = makeRes();
  await agentCtrl.createAgent({ auth: authAdmin(tenantId), body: { name: "Agent B", email: emailB, password: "P@ssw0rd1" } }, createBRes);
  assert.equal(createBRes.statusCode, 201);
  const agentBId = createBRes.body.data._id.toString();

  const listRes = makeRes();
  await agentCtrl.listAgents({ auth: authAdmin(tenantId), query: {} }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 2);

  // ---- Agent-side login ----
  const wrongPassRes = makeRes();
  await agentCtrl.agentLogin({ body: { email: emailA, password: "wrong" } }, wrongPassRes);
  assert.equal(wrongPassRes.statusCode, 401);

  const loginARes = makeRes();
  await agentCtrl.agentLogin({ body: { email: emailA, password: "P@ssw0rd1" } }, loginARes);
  assert.equal(loginARes.statusCode, 200, JSON.stringify(loginARes.body));
  assert.ok(loginARes.body.data.token);

  const loginBRes = makeRes();
  await agentCtrl.agentLogin({ body: { email: emailB, password: "P@ssw0rd1" } }, loginBRes);
  assert.equal(loginBRes.statusCode, 200);

  // ---- A Global-scope commission rule: 10% of booking totalAmount ----
  await CommissionRuleModel.create({ tenantId, scope: "Global", type: "Percentage", value: 10, active: true });

  // ---- Agent A creates a customer + a booking through the agent portal ----
  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "Cust", lastName: "Omer", email: `cust.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });

  const bookARes = makeRes();
  await agentCtrl.createMyBooking({ agent: { agentId: agentAId, tenantId }, requestId: "r1", body: { customerId: customer._id.toString(), totalAmount: 1000, currency: "USD" } }, bookARes);
  assert.equal(bookARes.statusCode, 201, JSON.stringify(bookARes.body));
  const bookingAId = bookARes.body.data.bookingId.toString();

  const createdBooking = await BookingHeaderModel.findOne({ _id: bookingAId, tenantId }).lean();
  assert.equal(createdBooking.agentUserId, agentAId, "the booking must be attributed to the creating agent");
  assert.equal(createdBooking.assignedConsultant, null, "an agent-initiated booking must never be mis-attributed to a staff consultant");

  // ---- Real commission crediting — async off BookingCreated, so poll for it ----
  // Poll for the actual credited state (balance > 0), not just wallet
  // existence — getOrCreateWallet's own create() lands the wallet row (at
  // balance:0) before creditCommissionForBooking goes on to credit it, so
  // polling for mere existence can observe that brief in-between window.
  const wallet = await waitFor(async () => AgentWalletModel.findOne({ tenantId, agentId: agentAId, balance: { $gt: 0 } }).lean(), { timeoutMs: 20000 });
  assert.ok(wallet, "AgentCommissionService must create and credit the agent's wallet on a qualifying booking");
  assert.equal(wallet.balance, 100, "10% of a 1000 totalAmount booking is 100");
  assert.equal(wallet.currency, "USD");

  const transaction = await AgentWalletTransactionModel.findOne({ tenantId, walletId: wallet._id }).lean();
  assert.ok(transaction);
  assert.equal(transaction.type, "CommissionEarned");
  assert.equal(transaction.amount, 100);
  assert.equal(transaction.bookingId.toString(), bookingAId);

  // ---- Agent-side dashboard/wallet reflect the credit ----
  const dashRes = makeRes();
  await agentCtrl.getMyDashboard({ agent: { agentId: agentAId, tenantId } }, dashRes);
  assert.equal(dashRes.statusCode, 200);
  assert.equal(dashRes.body.data.bookingsCount, 1);
  assert.equal(dashRes.body.data.totalCommissionEarned, 100);

  const myWalletRes = makeRes();
  await agentCtrl.getMyWallet({ agent: { agentId: agentAId, tenantId } }, myWalletRes);
  assert.equal(myWalletRes.statusCode, 200);
  assert.equal(myWalletRes.body.data.wallet.balance, 100);
  assert.equal(myWalletRes.body.data.transactions.length, 1);

  // ---- Cross-agent isolation: Agent B sees none of Agent A's bookings/wallet/dashboard numbers ----
  const bBookingsRes = makeRes();
  await agentCtrl.getMyBookings({ agent: { agentId: agentBId, tenantId } }, bBookingsRes);
  assert.equal(bBookingsRes.statusCode, 200);
  assert.equal(bBookingsRes.body.data.total, 0, "Agent B must never see Agent A's bookings");

  const bWalletRes = makeRes();
  await agentCtrl.getMyWallet({ agent: { agentId: agentBId, tenantId } }, bWalletRes);
  assert.equal(bWalletRes.statusCode, 200);
  assert.equal(bWalletRes.body.data.wallet, null, "Agent B must have no wallet of their own yet");

  const bDashRes = makeRes();
  await agentCtrl.getMyDashboard({ agent: { agentId: agentBId, tenantId } }, bDashRes);
  assert.equal(bDashRes.statusCode, 200);
  assert.equal(bDashRes.body.data.bookingsCount, 0);
  assert.equal(bDashRes.body.data.totalCommissionEarned, 0);

  // ---- Suspend Agent A: login must stop working ----
  const suspendRes = makeRes();
  await agentCtrl.suspendAgent({ auth: authAdmin(tenantId), params: { agentId: agentAId } }, suspendRes);
  assert.equal(suspendRes.statusCode, 200);

  const loginAfterSuspendRes = makeRes();
  await agentCtrl.agentLogin({ body: { email: emailA, password: "P@ssw0rd1" } }, loginAfterSuspendRes);
  assert.equal(loginAfterSuspendRes.statusCode, 401);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
