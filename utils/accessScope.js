// Shared access-scope helper (§7 of the auth multi-tenancy fix). Every
// tenant-scoped controller query should spread getAccessScope(req) into its
// Mongo filter instead of hand-rolling { tenantId } or { tenantId, branchId }
// per endpoint — that's what keeps branch isolation enforced consistently
// instead of depending on each developer re-deriving the rule correctly.
//
// req.auth.roleScope is attached by middleware/authenticateAccessToken.js,
// resolved from the caller's Role.scope ("branch" | "tenant"):
//   - "tenant": the role can access every branch within its own tenant.
//   - "branch" (default, and the fail-safe when roleScope is missing/unknown):
//     the role is restricted to req.auth.branchId.
// Company (tenant) isolation is never optional — a missing tenantId always
// yields null, and callers must treat that as a 403, never as "match everything".
export const getAccessScope = (req) => {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return null;
  if (req.auth?.roleScope === "tenant") return { tenantId };
  return { tenantId, branchId: req.auth?.branchId || null };
};

// Convenience for callers that also accept a query-string branchId filter,
// e.g. `GET /customers?branchId=...`. A tenant-scoped caller may narrow to a
// specific branch via the query param; a branch-scoped caller's own
// req.auth.branchId always wins regardless of what the query string asks
// for, so a branch-restricted user can never widen their own access by
// passing a different branchId on the URL.
export const applyOptionalBranchFilter = (scope, requestedBranchId) => {
  if (!scope) return scope;
  if (!requestedBranchId) return scope;
  if (scope.branchId) return scope; // already branch-locked — query param cannot override it
  return { ...scope, branchId: requestedBranchId };
};
