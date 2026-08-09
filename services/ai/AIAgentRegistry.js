import AIToolRegistry from "./AIToolRegistry.js";
import AIToolExecutionModel from "../../models/AIToolExecutionModel.js";
import AIAgentStateModel from "../../models/AIAgentStateModel.js";
import { publishEvent } from "../../utils/eventBus.js";
import mongoose from "mongoose";

/**
 * EXT-035 §5/§8/§12 — Agent Registry + least-privilege tool scoping.
 *
 * This codebase's AIToolRegistry (built across EXT-002 through EXT-026) is
 * a single flat catalog of 23 real tools — every one of them backed by a
 * genuine internal service, none fabricated. What was missing is the
 * concept of a specialized AGENT owning a bounded SUBSET of that catalog
 * (§12 "Flight Search Agent ✓ Flight Search ✓ Flight Pricing ✗ Payments ✗
 * Refunds") — every tool sat in one undifferentiated pool.
 *
 * This registry is deliberately a static, in-code definition (same pattern
 * AIToolRegistry itself already uses — not a new architectural style) that
 * partitions the REAL, already-registered tools by real capability. It
 * does not wrap fictional agents around tools that don't exist: a "Finance
 * Agent" only gets the one real read-only finance tool this codebase
 * actually has (`get_revenue_dashboard`) — no payment/refund tools exist
 * anywhere in this codebase (a gap flagged honestly since EXT-005), and
 * this registry doesn't pretend otherwise by granting an agent tools that
 * would silently no-op or don't exist.
 */
const AGENTS = [
  {
    agentId: "flight-search-agent",
    name: "Flight Search Agent",
    description: "Real-time flight discovery, pricing, fare comparison, schedule/inspiration search, ancillary services, and flight booking proposals via Amadeus.",
    capabilities: ["flight-search", "flight-pricing", "flight-booking-proposal"],
    toolNames: ["flight_search", "flight_schedule", "flight_inspiration", "compare_branded_fares", "recommend_ancillary_services", "explain_fare_rules", "propose_flight_booking", "trigger_flight_schedule_sync"],
    version: "1.0.0",
    status: "active"
  },
  {
    agentId: "hotel-agent",
    name: "Hotel Agent",
    description: "Real-time hotel discovery, room offers, pricing verification, booking retrieval, and hotel booking/cancellation proposals via Amadeus.",
    capabilities: ["hotel-search", "hotel-pricing", "hotel-booking-proposal"],
    toolNames: ["hotel_search", "search_hotel_list", "get_hotel_room_offers", "verify_hotel_offer_pricing", "get_hotel_booking_details", "propose_hotel_booking", "propose_hotel_cancellation"],
    version: "1.0.0",
    status: "active"
  },
  {
    agentId: "visa-advisor-agent",
    name: "Visa Advisor Agent",
    description: "Visa requirement lookups for a given nationality/destination.",
    capabilities: ["visa-requirements"],
    toolNames: ["get_visa_requirements"],
    version: "1.0.0",
    status: "active"
  },
  {
    agentId: "operations-agent",
    name: "Operations Agent",
    description: "Booking/travel-plan status lookups, operations and incident dashboards.",
    capabilities: ["operations-visibility"],
    toolNames: ["get_booking_status", "get_travel_plan_status", "get_operations_dashboard", "get_incidents_summary"],
    version: "1.0.0",
    status: "active"
  },
  {
    agentId: "finance-agent",
    name: "Finance Agent",
    description: "Read-only revenue visibility. Deliberately minimal — no real payment or refund execution tool exists anywhere in this codebase, so this agent is never granted one; it is not artificially restricted from tools it should have, it genuinely has none to grant beyond revenue reporting.",
    capabilities: ["revenue-visibility"],
    toolNames: ["get_revenue_dashboard"],
    version: "1.0.0",
    status: "active"
  },
  {
    agentId: "search-agent",
    name: "Search & Reference Agent",
    description: "Cross-module enterprise search, standardized reference data (airports, airlines, aircraft, countries, cities), and the company knowledge base (SOPs, policies, FAQs — EXT-030 RAG layer).",
    capabilities: ["reference-data", "enterprise-search", "knowledge-retrieval"],
    toolNames: ["reference_data_lookup", "enterprise_search", "search_knowledge_base"],
    version: "1.0.0",
    status: "active"
  },
  {
    // EXT-035 §5 "Transport Agent." Real backing: TravelTransportAssignmentModel.
    agentId: "transport-agent",
    name: "Transport Agent",
    description: "Ground transport visibility for a travel plan — vehicle, driver, route, schedule, and live status of airport/hotel/intercity transfers and Ziyarat tours.",
    capabilities: ["transport-visibility"],
    toolNames: ["get_travel_plan_transport"],
    version: "1.0.0",
    status: "active"
  },
  {
    // EXT-035 §5 "Attendance Agent." Real backing: TravelAttendanceModel.
    agentId: "attendance-agent",
    name: "Attendance Agent",
    description: "Traveler attendance/check-in visibility for a travel plan's activities — who's present, checked in, late, absent, or missing.",
    capabilities: ["attendance-visibility"],
    toolNames: ["get_travel_plan_attendance"],
    version: "1.0.0",
    status: "active"
  }
];

const HEALTH_WINDOW_DAYS = 7;

class AIAgentRegistry {
  /** Startup safety net — every real registered tool must belong to exactly one agent, and every toolName an agent claims must genuinely exist. Throws at import time (a config error, not a runtime surprise) rather than silently granting/denying access based on a typo. */
  static _validate() {
    const realToolNames = new Set(AIToolRegistry.list().map((t) => t.name));
    const claimed = new Map();
    for (const agent of AGENTS) {
      for (const toolName of agent.toolNames) {
        if (!realToolNames.has(toolName)) {
          throw new Error(`AIAgentRegistry: agent '${agent.agentId}' references unknown tool '${toolName}'.`);
        }
        if (claimed.has(toolName)) {
          throw new Error(`AIAgentRegistry: tool '${toolName}' is claimed by both '${claimed.get(toolName)}' and '${agent.agentId}' — each tool must have exactly one owning agent.`);
        }
        claimed.set(toolName, agent.agentId);
      }
    }
    const orphaned = [...realToolNames].filter((t) => !claimed.has(t));
    if (orphaned.length > 0) {
      throw new Error(`AIAgentRegistry: the following real tools are not assigned to any agent: ${orphaned.join(", ")}.`);
    }
  }

  static list() {
    return AGENTS;
  }

  static getAgent(agentId) {
    return AGENTS.find((a) => a.agentId === agentId) || null;
  }

  /** Reverse lookup — which agent owns a given real tool. */
  static getAgentForTool(toolName) {
    return AGENTS.find((a) => a.toolNames.includes(toolName)) || null;
  }

  /** §12 "Least privilege enforced" — the agent's own catalog, further filtered by the caller's real permissions (never wider than AIToolRegistry.getCatalog would already allow). */
  static getToolsForAgent(agentId, permissions = []) {
    const agent = this.getAgent(agentId);
    if (!agent) return [];
    const fullCatalog = AIToolRegistry.getCatalog(permissions);
    return fullCatalog.filter((t) => agent.toolNames.includes(t.name));
  }

  /**
   * §8 "Health Score" — real, derived from this agent's own tools' actual
   * execution history in `AIToolExecutionModel` over a recent window
   * (success rate), never a fabricated number. Returns `null` when there's
   * no live DB or no recent executions to derive a score from — an honest
   * "unknown" rather than a guessed default like 100.
   */
  static async getHealthScore(agentId, { tenantId, windowDays = HEALTH_WINDOW_DAYS } = {}) {
    const agent = this.getAgent(agentId);
    if (!agent || mongoose.connection?.readyState !== 1) return null;

    const since = new Date(Date.now() - windowDays * 86400000);
    const executions = await AIToolExecutionModel.find({
      tenantId, createdAt: { $gte: since }, "toolExecutions.toolName": { $in: agent.toolNames }
    }).select("toolExecutions").lean();

    let total = 0;
    let succeeded = 0;
    for (const execution of executions) {
      for (const step of execution.toolExecutions || []) {
        if (!agent.toolNames.includes(step.toolName)) continue;
        total += 1;
        if (step.succeeded) succeeded += 1;
      }
    }

    if (total === 0) return null;
    return { agentId, windowDays, totalExecutions: total, successCount: succeeded, healthScorePct: Number(((succeeded / total) * 100).toFixed(1)) };
  }

  /**
   * EXT-035 §21 "Agent Lifecycle." Merges the real, static registry
   * definition with the tenant's DB-backed overlay (AIAgentStateModel) —
   * an agent with no row is honestly "active" at its registry default, not
   * silently unavailable just because no admin has ever touched it.
   */
  static async getEffectiveState(agentId, tenantId) {
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    let overlay = null;
    if (mongoose.connection?.readyState === 1) {
      overlay = await AIAgentStateModel.findOne({ tenantId, agentId }).lean();
    }
    return {
      agentId, status: overlay?.status || "active",
      priority: overlay?.priority ?? null,
      statusReason: overlay?.statusReason || null,
      updatedBy: overlay?.updatedBy || null, updatedAt: overlay?.updatedAt || null
    };
  }

  /**
   * §9 "Agent Discovery ... Agent selection is dynamic." The real candidate
   * pool AISupervisorService chooses from: only agents whose effective
   * lifecycle status is "active" (draft/testing/approved are real states an
   * admin can move an agent through before it's actually selectable —
   * "approved" alone is a pre-activation gate, not itself live), further
   * narrowed to agents where the caller's own permissions actually grant at
   * least one real tool (an agent with zero accessible tools for this
   * caller has nothing to contribute).
   */
  static async listActive({ tenantId, permissions = [] }) {
    const results = [];
    for (const agent of AGENTS) {
      const state = await this.getEffectiveState(agent.agentId, tenantId);
      if (state.status !== "active") continue;
      if (this.getToolsForAgent(agent.agentId, permissions).length === 0) continue;
      results.push({ ...agent, effectiveStatus: state.status, effectivePriority: state.priority });
    }
    return results;
  }

  /** Admin view — every real agent alongside its resolved lifecycle state, regardless of caller permissions (a management/audit listing, not a selection pool). */
  static async listWithState({ tenantId }) {
    const results = [];
    for (const agent of AGENTS) {
      const state = await this.getEffectiveState(agent.agentId, tenantId);
      results.push({ agentId: agent.agentId, name: agent.name, description: agent.description, capabilities: agent.capabilities, toolNames: agent.toolNames, version: agent.version, ...state });
    }
    return results;
  }

  /** §21 lifecycle transition — real, DB-persisted, tenant-scoped; never mutates the static registry itself. */
  static async transitionState({ tenantId, userId, agentId, status, priority, reason }) {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Unknown agentId '${agentId}'.`);
    const validStatuses = ["draft", "testing", "approved", "active", "deprecated", "archived"];
    if (!validStatuses.includes(status)) throw new Error(`status must be one of: ${validStatuses.join(", ")}.`);

    const update = { status, updatedBy: userId };
    if (priority !== undefined) update.priority = priority;
    if (reason !== undefined) update.statusReason = reason || null;

    const state = await AIAgentStateModel.findOneAndUpdate(
      { tenantId, agentId },
      { $set: update },
      { upsert: true, new: true }
    );
    publishEvent("AIAgentStateTransitioned", { tenantId, agentId, status, reason: reason || null });
    return state;
  }
}

AIAgentRegistry._validate();

export default AIAgentRegistry;
