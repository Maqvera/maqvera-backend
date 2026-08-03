import test from "node:test";
import assert from "node:assert/strict";
import VisaWorkflowService from "../services/VisaWorkflowService.js";

test("workflow definition exposes the expected states and transitions", () => {
  const definition = VisaWorkflowService.getWorkflowDefinition();

  assert.ok(definition.name.includes("Visa Case Workflow"));
  assert.ok(definition.states.some((state) => state.key === "documents_pending"));
  assert.ok(definition.transitions.some((transition) => transition.fromState === "documents_pending" && transition.toState === "documents_verified"));
});

test("workflow transition is allowed when guard conditions are satisfied", () => {
  const visaCase = {
    status: "documents_pending",
    workflow: {
      currentStep: "documents_pending",
      completedSteps: ["inquiry", "application_draft"]
    },
    requiredDocuments: [
      { documentType: "passport", isMandatory: true, status: "uploaded", verificationStatus: "verified" },
      { documentType: "photo", isMandatory: true, status: "uploaded", verificationStatus: "verified" }
    ],
    travelerSnapshot: {
      passportNumber: "ABC123",
      passportExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 2)
    },
    incidents: []
  };

  const result = VisaWorkflowService.evaluateTransition({ visaCase, targetState: "documents_verified", userRoles: ["officer"] });

  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
});

test("workflow transition blocks when open incidents exist", () => {
  const visaCase = {
    status: "documents_pending",
    workflow: { currentStep: "documents_pending" },
    requiredDocuments: [],
    travelerSnapshot: { passportNumber: "ABC123", passportExpiry: new Date(Date.now() + 10000000) },
    incidents: [{ status: "open", title: "Missing Police Clearance" }]
  };

  const result = VisaWorkflowService.evaluateTransition({ visaCase, targetState: "documents_verified", userRoles: ["officer"] });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("incidents block workflow")));
});

test("workflow definition includes SLA rules, escalation chain, and approval policies", () => {
  const definition = VisaWorkflowService.getWorkflowDefinition();

  assert.ok(Array.isArray(definition.slaRules) && definition.slaRules.length >= 5);
  assert.ok(Array.isArray(definition.escalationChain) && definition.escalationChain.length >= 5);
  assert.ok(Array.isArray(definition.approvalPolicies) && definition.approvalPolicies.length >= 5);
});

