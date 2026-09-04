import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import AIAgentRegistry from "../services/ai/AIAgentRegistry.js";
import AIToolRegistry from "../services/ai/AIToolRegistry.js";

dotenv.config();

// Gap 1.7 "Reporting agent" + "Incident Response agent" — real, already-
// existing VisaAnalyticsEngine dashboards and EnterpriseIncidentEngineService
// methods wrapped as tools, added to two new bounded agents. The one
// mutating capability (incident assignment) only ever goes through the
// same propose_*+human-approval pattern already used for bookings — this
// suite proves it creates a pending approval request, never a direct
// mutation.

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

// ---- Pure registry-shape tests (no DB) ----

test("AIAgentRegistry: reporting-agent and incident-response-agent are real, registered agents with the expected tool boundaries", () => {
  const reporting = AIAgentRegistry.getAgent("reporting-agent");
  assert.ok(reporting);
  assert.deepEqual(reporting.toolNames.sort(), ["get_compliance_dashboard", "get_executive_dashboard"]);

  const incidentResponse = AIAgentRegistry.getAgent("incident-response-agent");
  assert.ok(incidentResponse);
  assert.deepEqual(incidentResponse.toolNames.sort(), ["get_incident_details", "get_incidents_summary", "propose_incident_assignment"]);

  // get_incidents_summary moved from operations-agent to incident-response-agent.
  const operations = AIAgentRegistry.getAgent("operations-agent");
  assert.ok(!operations.toolNames.includes("get_incidents_summary"));
});

test("AIAgentRegistry.getAgentForTool resolves each new tool to exactly the agent that owns it", () => {
  assert.equal(AIAgentRegistry.getAgentForTool("get_executive_dashboard").agentId, "reporting-agent");
  assert.equal(AIAgentRegistry.getAgentForTool("get_compliance_dashboard").agentId, "reporting-agent");
  assert.equal(AIAgentRegistry.getAgentForTool("get_incident_details").agentId, "incident-response-agent");
  assert.equal(AIAgentRegistry.getAgentForTool("propose_incident_assignment").agentId, "incident-response-agent");
});

test("propose_incident_assignment is a real, high-risk, approval-gated tool — never directly executable", () => {
  const tool = AIToolRegistry.getTool("propose_incident_assignment");
  assert.ok(tool);
  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.riskLevel, "high");
  assert.equal(tool.requiredApprovalRole, "admin");
});

// ---- DB-gated integration tests ----

const baseContext = (tenantId, overrides = {}) => ({ tenantId, userId: "tester", userName: "Tester", permissions: ["incidents.read", "incidents.write", "visa.read"], role: "agent", ...overrides });

test("get_incident_details returns the full real incident record for one specific incident", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const EnterpriseIncidentEngineService = (await import("../services/EnterpriseIncidentEngineService.js")).default;
  const TravelIncidentManagementModel = (await import("../models/TravelIncidentManagementModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-incident-agent-${suffix}`;
  t.after(async () => { await TravelIncidentManagementModel.deleteMany({ tenantId }); });

  const incident = await EnterpriseIncidentEngineService.createIncident({ category: "Lost Passport", type: "Lost Passport", description: "Traveler reported a lost passport at the airport.", severity: "High" }, tenantId, "tester");

  const outcome = await AIToolRegistry.execute("get_incident_details", { incidentId: incident._id.toString() }, baseContext(tenantId));
  assert.ok(!outcome.error, JSON.stringify(outcome));
  assert.equal(outcome.result.description, "Traveler reported a lost passport at the airport.");
  assert.equal(outcome.result.severity, "High");
});

test("get_executive_dashboard / get_compliance_dashboard: honest denial without visa.dashboard.management, real data with it", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const suffix = Date.now();
  const tenantId = `test-reporting-agent-${suffix}`;

  const withoutManagement = baseContext(tenantId, { permissions: ["visa.read"] });
  const execDenied = await AIToolRegistry.execute("get_executive_dashboard", {}, withoutManagement);
  assert.equal(execDenied.result.denied, true);
  const complianceDenied = await AIToolRegistry.execute("get_compliance_dashboard", {}, withoutManagement);
  assert.equal(complianceDenied.result.denied, true);

  const withManagement = baseContext(tenantId, { permissions: ["visa.read", "visa.dashboard.management"] });
  const execAllowed = await AIToolRegistry.execute("get_executive_dashboard", {}, withManagement);
  assert.ok(!execAllowed.error, JSON.stringify(execAllowed));
  assert.equal(execAllowed.result.denied, undefined);
  const complianceAllowed = await AIToolRegistry.execute("get_compliance_dashboard", {}, withManagement);
  assert.ok(!complianceAllowed.error, JSON.stringify(complianceAllowed));
  assert.equal(complianceAllowed.result.denied, undefined);
});

test("propose_incident_assignment creates a real pending approval request carrying the exact real endpoint call — never assigns the incident itself", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const EnterpriseIncidentEngineService = (await import("../services/EnterpriseIncidentEngineService.js")).default;
  const TravelIncidentManagementModel = (await import("../models/TravelIncidentManagementModel.js")).default;
  const AIApprovalRequestModel = (await import("../models/AIApprovalRequestModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-incident-assign-${suffix}`;
  t.after(async () => {
    await TravelIncidentManagementModel.deleteMany({ tenantId });
    await AIApprovalRequestModel.deleteMany({ tenantId });
  });

  const incident = await EnterpriseIncidentEngineService.createIncident({ category: "Flight", type: "Flight Delay", description: "Flight delayed 6 hours, group needs rebooking guidance.", severity: "Medium" }, tenantId, "tester");
  const incidentId = incident._id.toString();

  const outcome = await AIToolRegistry.execute("propose_incident_assignment", { incidentId, userId: "agent-42", userName: "Ayesha", team: "Operations" }, baseContext(tenantId));
  assert.ok(!outcome.error, JSON.stringify(outcome));
  assert.equal(outcome.result.status, "pending");
  assert.ok(outcome.result.approvalRequestId);

  const approval = await AIApprovalRequestModel.findById(outcome.result.approvalRequestId).lean();
  assert.ok(approval, "a real AIApprovalRequestModel row must exist");
  assert.equal(approval.status, "pending");
  assert.equal(approval.proposedAction.method, "POST");
  assert.equal(approval.proposedAction.endpoint, `/api/v1/incidents/${incidentId}/assign`);
  assert.deepEqual(approval.proposedAction.body, { userId: "agent-42", userName: "Ayesha", team: "Operations" });
  assert.equal(approval.requiredRole, "admin");

  // The incident itself must NOT actually be assigned yet — only a human's
  // real approval (a separate, already-existing flow) does that.
  const stillUnassigned = await EnterpriseIncidentEngineService.getIncidentById(incidentId, tenantId);
  assert.equal(stillUnassigned.assignedTo, null);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
