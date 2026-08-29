// Shared access-scope helper. Company = tenant, and the tenant boundary is
// the ONLY data-isolation boundary in this system (see
// docs/06-external-integrations/03-final-architecture-no-branches-rbac.md) —
// there is no branch-level data ownership. Every tenant-scoped controller
// query should spread getAccessScope(req) into its Mongo filter instead of
// hand-rolling { tenantId } per endpoint, so a future change to what
// "isolation" means only has to happen in one place.
//
// A missing tenantId always yields null, and callers must treat that as a
// 403, never as "match everything" — company isolation is never optional.
// Within a tenant, every authenticated user sees the same shared business
// data; WHICH APIs/actions they may use is governed entirely by
// req.auth.permissions (Role.permissions — see utils/authDomainDefaults.js
// and controllers/RoleController.js), not by this helper.
export const getAccessScope = (req) => {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return null;
  return { tenantId };
};

// B2B Agent Portal (PRD "CRM Feature Map by Phase" Phase 2 module 14) —
// deliberately NOT a reuse of getAccessScope above. An Agent is a genuinely
// separate external identity (middleware/authenticateAgentToken.js sets
// req.agent, never req.auth) whose scope is narrower than a tenant staff
// member's: own records only, never the whole tenant's shared business
// data. Every agent-portal controller must spread this into its Mongo
// filter (never a bare { tenantId } and never a bare { agentId } alone —
// both dimensions together, same "never optional" discipline as
// getAccessScope's own tenantId).
export const getAgentAccessScope = (req) => {
  const tenantId = req.agent?.tenantId;
  const agentId = req.agent?.agentId;
  if (!tenantId || !agentId) return null;
  return { tenantId, agentId };
};

// Supplier Self-Service Portal (PRD "CRM Feature Map by Phase" Phase 3
// module 24) — same "own token type, own req field, own narrower scope"
// discipline as getAgentAccessScope above. A vendor's portal token
// (middleware/authenticateVendorPortalToken.js) sets req.vendorAuth, never
// req.auth, and only ever sees its own vendor's records — never the
// tenant's shared business data.
export const getVendorAccessScope = (req) => {
  const tenantId = req.vendorAuth?.tenantId;
  const vendorId = req.vendorAuth?.vendorId;
  if (!tenantId || !vendorId) return null;
  return { tenantId, vendorId };
};
