import test from "node:test";
import assert from "node:assert/strict";
import VisaService from "../services/VisaService.js";

// Mock VisaCaseModel.findOne helper
const createMockVisaCase = () => ({
  _id: "507f1f77bcf86cd799439099",
  tenantId: "tenant_abc",
  status: "documents_pending",
  incidents: [],
  timeline: [],
  isLocked: false,
  lockReason: null,
  save: async function() { return this; }
});

test("VisaService adds incident and auto-locks case on Critical severity", async () => {
  const visaCase = createMockVisaCase();
  VisaService.getVisaCaseById = async () => visaCase;

  const incident = await VisaService.addVisaCaseIncident(
    visaCase._id,
    {
      category: "Lost Passport",
      severity: "Emergency",
      title: "Passport lost in courier transit",
      description: "TCS tracking shows missing package."
    },
    "tenant_abc",
    "user_admin"
  );

  assert.equal(incident.severity, "Emergency");
  assert.equal(visaCase.isLocked, true);
  assert.ok(visaCase.lockReason.includes("auto-locked due to Emergency incident"));
  assert.equal(visaCase.incidents.length, 1);
  assert.ok(visaCase.timeline.some((t) => t.event === "IncidentReported"));
});
