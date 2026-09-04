import AgentService from "../services/AgentService.js";
import AgentAnalyticsService from "../services/AgentAnalyticsService.js";
import { CreateBooking } from "./BookingController.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope, getAgentAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("Invalid email or password") || message.includes("account is")) return 401;
  if (message.includes("already exists")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid")) return 400;
  return 500;
};

// ---- Staff-side management (authenticateAccessToken) ----

export const createAgent = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "agent.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const agent = await AgentService.createAgent(req.body, scope.tenantId, req.auth?.id || null);
    return sendSuccess(res, 201, "Agent created successfully.", agent, requestId);
  } catch (error) {
    console.error("createAgent error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create agent.", requestId);
  }
};

export const listAgents = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "agent.read", "agent.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await AgentService.listAgents(req.query, scope.tenantId);
    return sendSuccess(res, 200, "Agents retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listAgents error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve agents.", requestId);
  }
};

/**
 * GET /agents/reports/performance?from=&to=&limit= — ranking + revenue-by-
 * agent (gap-audit "Gap E"). Read-only aggregation over already-real
 * BookingHeaderModel.agentUserId / AgentWalletTransactionModel data — no
 * new domain concept.
 */
export const getAgentPerformanceReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "agent.read", "agent.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const report = await AgentAnalyticsService.getAgentPerformanceReport(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Agent performance report retrieved successfully.", report, requestId);
  } catch (error) {
    console.error("getAgentPerformanceReport error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve agent performance report.", requestId);
  }
};

export const suspendAgent = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "agent.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const agent = await AgentService.suspendAgent(req.params.agentId, scope.tenantId, req.auth?.id || null);
    return sendSuccess(res, 200, "Agent suspended successfully.", agent, requestId);
  } catch (error) {
    console.error("suspendAgent error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to suspend agent.", requestId);
  }
};

// ---- Agent-side auth (public) ----

export const agentLogin = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const { email, password } = req.body;
    if (!email || !password) return sendError(res, 400, "email and password are required.", requestId);

    const result = await AgentService.login(email, password);
    return sendSuccess(res, 200, "Login successful.", result, requestId);
  } catch (error) {
    console.error("agentLogin error:", error);
    return sendError(res, statusFromError(error), error.message || "Login failed.", requestId);
  }
};

// ---- Agent-side portal (authenticateAgentToken) ----

export const getMyDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAgentAccessScope(req);
    if (!scope) return sendError(res, 403, "Agent context is required.", requestId);

    const dashboard = await AgentService.getDashboard(scope.agentId, scope.tenantId);
    return sendSuccess(res, 200, "Agent dashboard retrieved successfully.", dashboard, requestId);
  } catch (error) {
    console.error("getMyDashboard error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve agent dashboard.", requestId);
  }
};

export const getMyBookings = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAgentAccessScope(req);
    if (!scope) return sendError(res, 403, "Agent context is required.", requestId);

    const result = await AgentService.getMyBookings(scope.agentId, scope.tenantId, req.query);
    return sendSuccess(res, 200, "Agent bookings retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getMyBookings error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve agent bookings.", requestId);
  }
};

/**
 * POST /agents/me/bookings — calls controllers/BookingController.js's
 * CreateBooking directly (synthetic req/res) rather than re-deriving its
 * validation/number-generation/workflow/timeline logic a second time here —
 * same "don't duplicate creation logic" convention as
 * services/LeadService.js's convertToCustomer. `agentUserId` is forced to
 * the calling agent's own id, never caller-suppliable, so an agent can only
 * ever attribute a booking (and its resulting commission) to themselves.
 */
export const createMyBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAgentAccessScope(req);
    if (!scope) return sendError(res, 403, "Agent context is required.", requestId);

    const fakeReq = {
      auth: { tenantId: scope.tenantId, id: scope.agentId, permissions: ["booking.create"] },
      requestId,
      body: { ...req.body, assignedConsultant: null, agentUserId: scope.agentId }
    };
    const fakeRes = {
      statusCode: null, body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };

    await CreateBooking(fakeReq, fakeRes);
    return res.status(fakeRes.statusCode).json({ ...fakeRes.body, requestId });
  } catch (error) {
    console.error("createMyBooking error:", error);
    return sendError(res, 500, error.message || "Failed to create booking.", requestId);
  }
};

export const getMyWallet = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAgentAccessScope(req);
    if (!scope) return sendError(res, 403, "Agent context is required.", requestId);

    const result = await AgentService.getMyWallet(scope.agentId, scope.tenantId);
    return sendSuccess(res, 200, "Agent wallet retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("getMyWallet error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve agent wallet.", requestId);
  }
};
