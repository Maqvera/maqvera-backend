import dotenv from "dotenv";
import mongoose from "mongoose";
import WorkflowDefinitionModel from "../models/WorkflowDefinitionModel.js";
import VisaWorkflowService from "../services/VisaWorkflowService.js";

dotenv.config();
const tenantId = process.env.SEED_TENANT_ID;
if (!tenantId) throw new Error("SEED_TENANT_ID is required to seed a Visa workflow.");

if (!process.env.URI) throw new Error("URI is required to seed a Visa workflow.");
await mongoose.connect(process.env.URI);
const definition = VisaWorkflowService.getDefaultWorkflowDefinition(1);
await WorkflowDefinitionModel.findOneAndUpdate(
  { tenantId, entityType: "Visa", version: 1 },
  {
    tenantId,
    entityType: "Visa",
    workflowName: definition.name,
    initialState: definition.states.find((state) => state.type === "initial")?.key || definition.states[0].key,
    version: 1,
    isActive: true,
    isDefault: true,
    states: definition.states.map((state) => ({ stateId: state.key, label: state.label, description: state.description || null })),
    transitions: definition.transitions.map((transition) => ({ fromState: transition.fromState, action: transition.action, toState: transition.toState, requiredPermission: transition.requiredRole || null })),
    slaPolicies: definition.slaRules,
    escalationRules: definition.escalationChain,
    approvalPolicies: definition.approvalPolicies,
    automationRules: definition.automationRules
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);
await mongoose.disconnect();
console.log(`Visa workflow v1 configured for tenant ${tenantId}.`);
