import jwt from "jsonwebtoken";
import { sendError } from "../utils/apiResponse.js";
import { getAuthConfig } from "../utils/authConfig.js";
import AgentModel from "../models/AgentModel.js";

const authConfig = getAuthConfig();

/**
 * B2B Agent Portal (PRD "CRM Feature Map by Phase" Phase 2 module 14) —
 * the Agent-side counterpart to middleware/authenticateAccessToken.js.
 * Deliberately a separate middleware, not a branch inside the staff one:
 * an Agent token carries no `role`/`permissions` claim to resolve (an
 * agent's access is fixed — its own records only, via
 * utils/accessScope.js's getAgentAccessScope), and re-checks the Agent's
 * live `status` on every request (a suspended agent's still-valid JWT must
 * stop working immediately, not just at its next login).
 */
const authenticateAgentToken = async (req, res, next) => {
  const requestId = req.requestId || req.header("X-Request-ID") || null;
  const authorization = req.header("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return sendError(res, 401, "Missing JWT", requestId);
  }
  const token = authorization.slice(7).trim();

  let payload;
  try {
    payload = jwt.verify(token, authConfig.accessTokenSecret);
  } catch (error) {
    return sendError(res, 401, error.name === "TokenExpiredError" ? "Expired JWT" : "Invalid JWT", requestId);
  }
  if (payload.type !== "agent_access") {
    return sendError(res, 401, "Invalid JWT", requestId);
  }

  const agent = await AgentModel.findOne({ _id: payload.agentId, tenantId: payload.tenantId }).select("status").lean();
  if (!agent) return sendError(res, 401, "Agent account no longer exists.", requestId);
  if (agent.status !== "Active") return sendError(res, 403, `Agent account is ${agent.status.toLowerCase()}.`, requestId);

  req.agent = { agentId: payload.agentId, tenantId: payload.tenantId };
  next();
};

export default authenticateAgentToken;
