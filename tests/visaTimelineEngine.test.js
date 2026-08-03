import test from "node:test";
import assert from "node:assert/strict";
import EnterpriseTimelineEngineService from "../services/EnterpriseTimelineEngineService.js";
import VisaTimelineEventBus from "../services/VisaTimelineEventBus.js";

test("manual notes reject missing or oversized content before persistence", async () => {
  await assert.rejects(
    EnterpriseTimelineEngineService.recordManualNote({ tenantId: "tenant-a", visaCaseId: "case-a", text: "" }),
    /Note text is required/
  );

  await assert.rejects(
    EnterpriseTimelineEngineService.recordManualNote({ tenantId: "tenant-a", visaCaseId: "case-a", text: "x".repeat(5001) }),
    /cannot exceed 5000/
  );
});

test("Visa Timeline Event Bus initializes only once", () => {
  VisaTimelineEventBus.initialized = false;
  VisaTimelineEventBus.init();
  assert.equal(VisaTimelineEventBus.initialized, true);
  VisaTimelineEventBus.init();
  assert.equal(VisaTimelineEventBus.initialized, true);
});
