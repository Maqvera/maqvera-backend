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

// Deprecated: branches are no longer a data-isolation boundary, so there is
// nothing left to "optionally narrow" — kept as a no-op passthrough purely
// so existing call sites (`{ ...applyOptionalBranchFilter(scope, req.query.branchId), ... }`)
// don't need touching one by one. A caller-supplied branchId query param is
// intentionally ignored, not applied as a filter.
export const applyOptionalBranchFilter = (scope) => scope;
