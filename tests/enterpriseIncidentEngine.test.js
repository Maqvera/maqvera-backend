import test from "node:test";
import assert from "node:assert/strict";
import EnterpriseIncidentEngineService from "../services/EnterpriseIncidentEngineService.js";
import VisaService from "../services/VisaService.js";

// Helper mocks
const createMockVisaCase = (id = "507f1f77bcf86cd799439099") => ({
  _id: id,
  tenantId: "tenant_enterprise",
  caseNumber: "VIS-2026-000001",
  travelerId: "60d5ecb8b5c9c2234c8e4321",
  status: "documents_pending",
  incidents: [],
  timeline: [],
  isLocked: false,
  lockReason: null,
  workflow: { isBlocked: false, blockReason: null },
  save: async function() { return this; }
});

test("EnterpriseIncidentEngineService calculates SLA correctly based on severity", () => {
  const emergencySLA = EnterpriseIncidentEngineService.calculateSLA("Emergency");
  assert.ok(emergencySLA.firstResponseDueDate);
  assert.ok(emergencySLA.resolutionDueDate);
  assert.equal(emergencySLA.isViolated, false);

  const lowSLA = EnterpriseIncidentEngineService.calculateSLA("Low");
  assert.ok(lowSLA.resolutionDueDate.getTime() > emergencySLA.resolutionDueDate.getTime());
});

test("VisaService adds incident via EnterpriseIncidentEngine and auto-locks Visa Case on Critical severity", async () => {
  const mockVisaCase = createMockVisaCase();
  
  // Patch model lookups
  VisaService.getVisaCaseById = async () => mockVisaCase;

  const incident = await VisaService.addVisaCaseIncident(
    mockVisaCase._id,
    {
      category: "Lost Passport",
      severity: "Emergency",
      title: "Passport lost in courier transit",
      description: "Courier package untraceable."
    },
    "tenant_enterprise",
    "user_officer"
  );

  assert.equal(incident.severity, "Emergency");
  assert.ok(incident.incidentNumber.startsWith("INC-"));
  assert.equal(mockVisaCase.isLocked, true);
  assert.ok(mockVisaCase.lockReason.includes("Emergency incident"));
  assert.equal(mockVisaCase.incidents.length, 1);
});

test("EnterpriseIncidentEngineService generates valid analytics payload", async () => {
  const analytics = await EnterpriseIncidentEngineService.getIncidentAnalytics("tenant_enterprise");
  assert.ok("totalIncidents" in analytics);
  assert.ok("severityBreakdown" in analytics);
  assert.ok("slaComplianceRate" in analytics);
  assert.ok("aiTrendInsights" in analytics);
});
