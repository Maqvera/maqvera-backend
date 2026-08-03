import WorkflowInstanceModel from "../models/WorkflowInstanceModel.js";
import { getBookingConfig } from "../utils/bookingConfig.js";
import { getTravelConfig } from "../utils/travelConfig.js";
import { getFlightConfig } from "../utils/flightConfig.js";
import { getHotelConfig } from "../utils/hotelConfig.js";
import { getTransportConfig } from "../utils/transportConfig.js";
import { getItineraryConfig } from "../utils/itineraryConfig.js";
import { getAttendanceConfig } from "../utils/attendanceConfig.js";

const normalizeStateValue = (value, fallback = "draft") => `${value || fallback}`.trim().toLowerCase();

const getWorkflowTransitionsForEntity = (entityType = "Booking") => {
  const bookingConfig = getBookingConfig();
  const entityKey = `${entityType}`.trim().toLowerCase();

  // Travel Plan has its own independent lifecycle (Section 4 of the Travel
  // Operations doc) — unrelated to Booking's, so this returns ONLY travel
  // transitions (not merged with the booking ones, same isolation pattern
  // already used for the "task" branch below).
  if (entityKey === "travelplan") {
    const travelConfig = getTravelConfig();
    return travelConfig.workflowTransitions.map((transition) => ({
      fromState: normalizeStateValue(transition.fromState, "planning"),
      action: `${transition.action || "advance"}`.trim(),
      toState: normalizeStateValue(transition.toState, "planning"),
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null
    }));
  }

  // Flight Operations (Part 3) has its own independent lifecycle, unrelated
  // to Travel Plan's or Booking's — same isolation pattern.
  if (entityKey === "flight") {
    const flightConfig = getFlightConfig();
    return flightConfig.workflowTransitions.map((transition) => ({
      fromState: normalizeStateValue(transition.fromState, "scheduled"),
      action: `${transition.action || "advance"}`.trim(),
      toState: normalizeStateValue(transition.toState, "scheduled"),
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null
    }));
  }

  // Hotel Operations (Part 4) has its own independent lifecycle.
  if (entityKey === "hotel") {
    const hotelConfig = getHotelConfig();
    return hotelConfig.workflowTransitions.map((transition) => ({
      fromState: normalizeStateValue(transition.fromState, "planned"),
      action: `${transition.action || "advance"}`.trim(),
      toState: normalizeStateValue(transition.toState, "planned"),
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null
    }));
  }

  // Transport Management (Part 5) has its own independent lifecycle.
  if (entityKey === "transport") {
    const transportConfig = getTransportConfig();
    return transportConfig.workflowTransitions.map((transition) => ({
      fromState: normalizeStateValue(transition.fromState, "planned"),
      action: `${transition.action || "advance"}`.trim(),
      toState: normalizeStateValue(transition.toState, "planned"),
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null
    }));
  }

  // Itinerary Management (Part 6) has its own independent lifecycle.
  if (entityKey === "activity") {
    const itineraryConfig = getItineraryConfig();
    return itineraryConfig.workflowTransitions.map((transition) => ({
      fromState: normalizeStateValue(transition.fromState, "draft"),
      action: `${transition.action || "advance"}`.trim(),
      toState: normalizeStateValue(transition.toState, "draft"),
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null
    }));
  }

  // Attendance Management (Part 7) has its own independent lifecycle.
  if (entityKey === "attendance") {
    const attendanceConfig = getAttendanceConfig();
    return attendanceConfig.workflowTransitions.map((transition) => ({
      fromState: normalizeStateValue(transition.fromState, "scheduled"),
      action: `${transition.action || "advance"}`.trim(),
      toState: normalizeStateValue(transition.toState, "scheduled"),
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null
    }));
  }

  const transitions = bookingConfig.workflowTransitions.map((transition) => ({
    fromState: normalizeStateValue(transition.fromState, "draft"),
    action: `${transition.action || "advance"}`.trim(),
    toState: normalizeStateValue(transition.toState, "draft"),
    approvalRequired: Boolean(transition.approvalRequired),
    approvalRole: transition.approvalRole || null
  }));

  if (entityKey === "visa") {
    return [
      ...transitions,
      { fromState: "draft", action: "submit", toState: "submitted", approvalRequired: false, approvalRole: null },
      { fromState: "submitted", action: "review", toState: "reviewed", approvalRequired: false, approvalRole: null },
      { fromState: "reviewed", action: "approve", toState: "approved", approvalRequired: false, approvalRole: null },
      { fromState: "submitted", action: "reject", toState: "rejected", approvalRequired: true, approvalRole: "supervisor" }
    ];
  }

  // Booking Operations Part 6: "Task Workflow ... Workflow managed by
  // Generic Workflow Engine." A task's lifecycle is unrelated to a
  // booking's, so this returns ONLY task transitions (not merged with the
  // booking ones, unlike the visa branch above — a task should never be
  // able to "transition" into a booking-specific state like "quotation").
  if (entityKey === "task") {
    return [
      { fromState: "created", action: "Assign Task", toState: "assigned", approvalRequired: false, approvalRole: null },
      { fromState: "assigned", action: "Start Task", toState: "in_progress", approvalRequired: false, approvalRole: null },
      { fromState: "in_progress", action: "Complete Task", toState: "completed", approvalRequired: false, approvalRole: null },
      { fromState: "created", action: "Cancel Task", toState: "cancelled", approvalRequired: false, approvalRole: null },
      { fromState: "assigned", action: "Cancel Task", toState: "cancelled", approvalRequired: false, approvalRole: null },
      { fromState: "in_progress", action: "Cancel Task", toState: "cancelled", approvalRequired: false, approvalRole: null },
      { fromState: "assigned", action: "Mark Overdue", toState: "overdue", approvalRequired: false, approvalRole: null },
      { fromState: "in_progress", action: "Mark Overdue", toState: "overdue", approvalRequired: false, approvalRole: null }
    ];
  }

  return transitions;
};

export const getWorkflowDefinitionForEntity = (entityType = "Booking") => {
  const bookingConfig = getBookingConfig();
  const entityName = `${entityType || "Booking"}`.trim();
  const entityKey = entityName.toLowerCase();
  const transitions = getWorkflowTransitionsForEntity(entityName);

  if (entityKey === "travelplan") {
    const travelConfig = getTravelConfig();
    const states = (travelConfig.workflowStates || []).map((state) => ({
      stateId: `${state.stateId || "planning"}`.trim().toLowerCase(),
      label: state.label || state.stateId || "Planning",
      description: state.description || state.label || state.stateId || "Workflow state"
    }));
    return {
      workflowName: `${entityName} Workflow`,
      entityType: entityName,
      initialState: travelConfig.defaultTravelStatus || "planning",
      version: 1,
      isActive: true,
      states,
      transitions: transitions.map((transition) => ({
        fromState: transition.fromState,
        action: transition.action,
        toState: transition.toState,
        approvalRequired: Boolean(transition.approvalRequired),
        approvalRole: transition.approvalRole || null,
        autoActions: [],
        guardConditions: []
      })),
      guardConditions: [],
      automationRules: [],
      slaPolicies: [],
      escalationRules: [],
      approvalPolicies: [],
      isDefault: true
    };
  }

  if (entityKey === "flight") {
    const flightConfig = getFlightConfig();
    const states = (flightConfig.workflowStates || []).map((state) => ({
      stateId: `${state.stateId || "scheduled"}`.trim().toLowerCase(),
      label: state.label || state.stateId || "Scheduled",
      description: state.description || state.label || state.stateId || "Workflow state"
    }));
    return {
      workflowName: `${entityName} Workflow`,
      entityType: entityName,
      initialState: flightConfig.defaultFlightStatus || "scheduled",
      version: 1,
      isActive: true,
      states,
      transitions: transitions.map((transition) => ({
        fromState: transition.fromState,
        action: transition.action,
        toState: transition.toState,
        approvalRequired: Boolean(transition.approvalRequired),
        approvalRole: transition.approvalRole || null,
        autoActions: [],
        guardConditions: []
      })),
      guardConditions: [],
      automationRules: [],
      slaPolicies: [],
      escalationRules: [],
      approvalPolicies: [],
      isDefault: true
    };
  }

  if (entityKey === "hotel") {
    const hotelConfig = getHotelConfig();
    const states = (hotelConfig.workflowStates || []).map((state) => ({
      stateId: `${state.stateId || "planned"}`.trim().toLowerCase(),
      label: state.label || state.stateId || "Planned",
      description: state.description || state.label || state.stateId || "Workflow state"
    }));
    return {
      workflowName: `${entityName} Workflow`,
      entityType: entityName,
      initialState: hotelConfig.defaultHotelStatus || "planned",
      version: 1,
      isActive: true,
      states,
      transitions: transitions.map((transition) => ({
        fromState: transition.fromState,
        action: transition.action,
        toState: transition.toState,
        approvalRequired: Boolean(transition.approvalRequired),
        approvalRole: transition.approvalRole || null,
        autoActions: [],
        guardConditions: []
      })),
      guardConditions: [],
      automationRules: [],
      slaPolicies: [],
      escalationRules: [],
      approvalPolicies: [],
      isDefault: true
    };
  }

  if (entityKey === "transport") {
    const transportConfig = getTransportConfig();
    const states = (transportConfig.workflowStates || []).map((state) => ({
      stateId: `${state.stateId || "planned"}`.trim().toLowerCase(),
      label: state.label || state.stateId || "Planned",
      description: state.description || state.label || state.stateId || "Workflow state"
    }));
    return {
      workflowName: `${entityName} Workflow`,
      entityType: entityName,
      initialState: transportConfig.defaultTransportStatus || "planned",
      version: 1,
      isActive: true,
      states,
      transitions: transitions.map((transition) => ({
        fromState: transition.fromState,
        action: transition.action,
        toState: transition.toState,
        approvalRequired: Boolean(transition.approvalRequired),
        approvalRole: transition.approvalRole || null,
        autoActions: [],
        guardConditions: []
      })),
      guardConditions: [],
      automationRules: [],
      slaPolicies: [],
      escalationRules: [],
      approvalPolicies: [],
      isDefault: true
    };
  }

  if (entityKey === "activity") {
    const itineraryConfig = getItineraryConfig();
    const states = (itineraryConfig.workflowStates || []).map((state) => ({
      stateId: `${state.stateId || "draft"}`.trim().toLowerCase(),
      label: state.label || state.stateId || "Draft",
      description: state.description || state.label || state.stateId || "Workflow state"
    }));
    return {
      workflowName: `${entityName} Workflow`,
      entityType: entityName,
      initialState: itineraryConfig.defaultActivityStatus || "draft",
      version: 1,
      isActive: true,
      states,
      transitions: transitions.map((transition) => ({
        fromState: transition.fromState,
        action: transition.action,
        toState: transition.toState,
        approvalRequired: Boolean(transition.approvalRequired),
        approvalRole: transition.approvalRole || null,
        autoActions: [],
        guardConditions: []
      })),
      guardConditions: [],
      automationRules: [],
      slaPolicies: [],
      escalationRules: [],
      approvalPolicies: [],
      isDefault: true
    };
  }

  if (entityKey === "attendance") {
    const attendanceConfig = getAttendanceConfig();
    const states = (attendanceConfig.workflowStates || []).map((state) => ({
      stateId: `${state.stateId || "scheduled"}`.trim().toLowerCase(),
      label: state.label || state.stateId || "Scheduled",
      description: state.description || state.label || state.stateId || "Workflow state"
    }));
    return {
      workflowName: `${entityName} Workflow`,
      entityType: entityName,
      initialState: (attendanceConfig.defaultAttendanceStatus || "Scheduled").toLowerCase(),
      version: 1,
      isActive: true,
      states,
      transitions: transitions.map((transition) => ({
        fromState: transition.fromState,
        action: transition.action,
        toState: transition.toState,
        approvalRequired: Boolean(transition.approvalRequired),
        approvalRole: transition.approvalRole || null,
        autoActions: [],
        guardConditions: []
      })),
      guardConditions: [],
      automationRules: [],
      slaPolicies: [],
      escalationRules: [],
      approvalPolicies: [],
      isDefault: true
    };
  }

  // Last-resort fallback only (bookingConfig.workflowStates is always
  // populated in practice) — kept in sync with the real default list, plus
  // the Visa-specific states getWorkflowTransitionsForEntity appends.
  const configuredStates = Array.isArray(bookingConfig.workflowStates) && bookingConfig.workflowStates.length > 0
    ? bookingConfig.workflowStates
    : [
        { stateId: "draft", label: "Draft", description: "Initial state" },
        { stateId: "quotation", label: "Quotation", description: "Quoted state" },
        { stateId: "reserved", label: "Reserved", description: "Reserved state" },
        { stateId: "confirmed", label: "Confirmed", description: "Confirmed state" },
        { stateId: "deposit_received", label: "Deposit Received", description: "Deposit received" },
        { stateId: "visa_processing", label: "Visa Processing", description: "Visa is being processed" },
        { stateId: "ticket_issued", label: "Ticket Issued", description: "Tickets issued" },
        { stateId: "travel_ready", label: "Travel Ready", description: "Travel ready" },
        { stateId: "traveling", label: "Traveling", description: "In transit" },
        { stateId: "completed", label: "Completed", description: "Completed state" },
        { stateId: "cancelled", label: "Cancelled", description: "Cancelled state" },
        { stateId: "refund_requested", label: "Refund Requested", description: "Refund requested" },
        { stateId: "refund_completed", label: "Refund Completed", description: "Refund completed" },
        { stateId: "archived", label: "Archived", description: "Archived state" },
        { stateId: "submitted", label: "Submitted", description: "Submitted state" },
        { stateId: "reviewed", label: "Reviewed", description: "Reviewed state" },
        { stateId: "approved", label: "Approved", description: "Approved state" },
        { stateId: "rejected", label: "Rejected", description: "Rejected state" }
      ];
  const states = configuredStates.map((state) => ({
    stateId: `${state.stateId || state.id || "draft"}`.trim().toLowerCase(),
    label: state.label || state.stateId || state.id || "Draft",
    description: state.description || state.label || state.stateId || "Workflow state"
  }));

  return {
    workflowName: `${entityName} Workflow`,
    entityType: entityName,
    initialState: bookingConfig.defaultBookingStatus || "draft",
    version: 1,
    isActive: true,
    states,
    transitions: transitions.map((transition) => ({
      fromState: transition.fromState,
      action: transition.action,
      toState: transition.toState,
      approvalRequired: Boolean(transition.approvalRequired),
      approvalRole: transition.approvalRole || null,
      autoActions: [],
      guardConditions: []
    })),
    guardConditions: [],
    automationRules: [],
    slaPolicies: [],
    escalationRules: [],
    approvalPolicies: [],
    isDefault: true
  };
};

export const getOrCreateWorkflowInstance = async ({ tenantId, entityType, entityId, initialState = "draft" }) => {
  let instance = await WorkflowInstanceModel.findOne({ tenantId, entityType, entityId });
  if (!instance) {
    instance = await WorkflowInstanceModel.create({
      tenantId,
      entityType,
      entityId,
      currentState: initialState,
      completedSteps: [initialState],
      history: [{
        fromState: initialState,
        toState: initialState,
        action: "Initialize Workflow",
        performedBy: "system",
        performedByName: "System",
        timestamp: new Date(),
        comments: `Workflow initialized in ${initialState} state`
      }]
    });
  }
  return instance;
};

export const getAllowedNextActions = (currentState, entityType = "Booking") => {
  const normState = (currentState || "draft").toLowerCase();
  const transitions = getWorkflowTransitionsForEntity(entityType);

  return transitions
    .filter((t) => t.fromState.toLowerCase() === normState)
    .map((t) => ({
      action: t.action,
      nextState: t.toState,
      approvalRequired: Boolean(t.approvalRequired),
      approvalRole: t.approvalRole || null
    }));
};

export const executeWorkflowTransition = async ({
  tenantId,
  entityType = "Booking",
  entityId,
  action,
  targetState = null,
  performedBy = null,
  performedByName = "Staff",
  userRoles = [],
  comments = null
}) => {
  const instance = await getOrCreateWorkflowInstance({ tenantId, entityType, entityId });
  const currentState = instance.currentState;

  const allowedTransitions = getWorkflowTransitionsForEntity(entityType).filter(
    (t) => t.fromState.toLowerCase() === currentState.toLowerCase()
  );

  let transition = null;
  if (action) {
    transition = allowedTransitions.find(
      (t) => t.action.toLowerCase() === action.trim().toLowerCase()
    );
  }

  if (!transition && targetState) {
    transition = allowedTransitions.find(
      (t) => t.toState.toLowerCase() === targetState.trim().toLowerCase()
    );
  }

  if (!transition) {
    throw new Error(`Transition '${action || targetState}' is not allowed from current state '${currentState}'.`);
  }

  if (transition.approvalRequired) {
    const requiredRole = transition.approvalRole || "admin";
    const hasRole = userRoles.includes(requiredRole) || userRoles.includes("admin") || userRoles.includes("superadmin");
    
    if (!hasRole) {
      instance.pendingApprovals.push({
        action: transition.action,
        targetState: transition.toState,
        requestedBy: performedBy || "staff",
        requestedByName: performedByName || "Staff",
        requiredRole,
        status: "pending",
        comments: comments || "Approval requested for workflow transition"
      });
      await instance.save();
      return {
        requiresApproval: true,
        approvalRole: requiredRole,
        currentState: instance.currentState,
        message: `Transition to ${transition.toState} requires approval by ${requiredRole}.`
      };
    }
  }

  // Close the approval loop: if this exact transition was previously blocked
  // pending approval (a lower-privileged user triggered it, got queued),
  // and it's now going through because the caller actually holds the
  // required role, mark those queued requests resolved instead of leaving
  // them "pending" forever with no consuming endpoint.
  if (transition.approvalRequired) {
    instance.pendingApprovals.forEach((pending) => {
      if (pending.status === "pending" && pending.action === transition.action && pending.targetState === transition.toState) {
        pending.status = "approved";
        pending.approvedBy = performedBy || "staff";
        pending.approvedByName = performedByName || "Staff";
        pending.approvedAt = new Date();
      }
    });
  }

  instance.previousState = currentState;
  instance.currentState = transition.toState;

  if (!instance.completedSteps.includes(transition.toState)) {
    instance.completedSteps.push(transition.toState);
  }

  instance.history.push({
    fromState: currentState,
    toState: transition.toState,
    action: transition.action,
    performedBy,
    performedByName: performedByName || "Staff",
    timestamp: new Date(),
    comments: comments || `Moved state from ${currentState} to ${transition.toState}`
  });

  if (transition.toState === "completed") {
    instance.status = "completed";
  } else if (transition.toState === "cancelled") {
    instance.status = "cancelled";
  }

  await instance.save();

  return {
    requiresApproval: false,
    previousState: currentState,
    currentState: transition.toState,
    actionPerformed: transition.action,
    instance
  };
};
