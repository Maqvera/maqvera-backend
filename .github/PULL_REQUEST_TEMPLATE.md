## Summary

<!-- What does this PR change, and why? -->

## Test plan

<!-- How was this verified? node --test "tests/*.test.js" output, manual steps, etc. -->

## Checklist

- [ ] `node --test "tests/*.test.js"` passes locally
- [ ] New/changed endpoint uses `getAccessScope(req)` (from `utils/accessScope.js`) for all tenant-owned queries — never a hand-rolled `{ tenantId }`/`{ tenantId, branchId }` filter, never `req.headers["x-tenant-id"]`/`x-branch-id`, never a hardcoded default tenant. See `CLAUDE.md` and `docs/06-external-integrations/02-tenant-isolation-audit.md`.
- [ ] If this PR migrates a controller to `getAccessScope`, its filename was added to `MIGRATED_TO_ACCESS_SCOPE` in `tests/accessScopeRegression.test.js`
- [ ] New routes explicitly set their own auth requirement (`authenticateAccessToken` or a documented, deliberate public exception) rather than relying on file-level defaults
