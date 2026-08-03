import test from "node:test";
import assert from "node:assert/strict";
import { getAllowedNextActions, getWorkflowDefinitionForEntity } from "../utils/WorkflowEngine.js";
import { getBookingConfig } from "../utils/bookingConfig.js";

test("booking workflow transitions can be configured from env", () => {
  const original = process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON;
  process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON = JSON.stringify([
    { fromState: "draft", action: "submit_for_review", toState: "submitted" }
  ]);

  try {
    const config = getBookingConfig();
    assert.ok(config.workflowTransitions.some((transition) => transition.action === "submit_for_review"));
  } finally {
    if (original === undefined) {
      delete process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON;
    } else {
      process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON = original;
    }
  }
});

test("allowed next actions are resolved from the configured workflow", () => {
  const original = process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON;
  process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON = JSON.stringify([
    { fromState: "draft", action: "submit_for_review", toState: "submitted" }
  ]);

  try {
    const actions = getAllowedNextActions("draft");
    assert.deepEqual(actions.map((action) => action.action), ["submit_for_review"]);
  } finally {
    if (original === undefined) {
      delete process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON;
    } else {
      process.env.BOOKING_WORKFLOW_DEFINITIONS_JSON = original;
    }
  }
});

test("workflow definitions are resolved generically for different entity types", () => {
  const definition = getWorkflowDefinitionForEntity("Visa");

  assert.equal(definition.entityType, "Visa");
  assert.ok(definition.states.length > 0);
  assert.ok(definition.transitions.length > 0);
});

test("workflow states can be configured from env", () => {
  const original = process.env.BOOKING_WORKFLOW_STATES_JSON;
  process.env.BOOKING_WORKFLOW_STATES_JSON = JSON.stringify([
    { stateId: "draft", label: "Draft" },
    { stateId: "submitted", label: "Submitted" }
  ]);

  try {
    const definition = getWorkflowDefinitionForEntity("Booking");
    assert.deepEqual(definition.states.map((state) => state.stateId), ["draft", "submitted"]);
  } finally {
    if (original === undefined) {
      delete process.env.BOOKING_WORKFLOW_STATES_JSON;
    } else {
      process.env.BOOKING_WORKFLOW_STATES_JSON = original;
    }
  }
});
