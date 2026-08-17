# Standard Metadata Model

**Status: ✔ Done** — real, applicable infrastructure (`utils/enterpriseMetadata.js`), not yet retrofitted onto any existing model (see "Adoption" below).

## The standard

Every business entity in this ERP should carry the same base metadata, exactly the way SAP/Oracle Fusion/Dynamics/Workday standardize theirs:

| Field | Source |
|---|---|
| `id` | MongoDB's own `_id` — every model already has this. |
| `tenantId` | Each model's own existing declaration (see `utils/accessScope.js`) — **not** injected by this standard; a second plugin-added declaration would risk conflicting with a model's own indexing rather than standardizing it. |
| `companyId` / `merchantAccountId` / `branchId` | Opt-in only. Real references into the Organisation (Improvement 4) and Merchant (Improvement 3) CORE platforms — added only to models that actually need them. `branchId` stays descriptive-only, never an isolation dimension (`docs/06-external-integrations/03-final-architecture-no-branches-rbac.md`). |
| `createdBy` / `updatedBy` | Already the near-universal convention across every model built by the recent Improvements; added only when a schema doesn't already define its own. |
| `createdAt` / `updatedAt` | Mongoose's own `{ timestamps: true }` — untouched, opted into the same way every model already does. |
| `version` | Mongoose's own optimistic-concurrency `__v` counter, turned on by default. `exposeVersion()` renames it to `version` in a model's own `toJSON` transform. |
| `status` | **Not** standardized here — most models already define their own richer enum; nothing generic to add without conflicting. |
| `correlationId` | The same `req.requestId` this codebase already threads through every response header and log line (`middleware/requestContext.js`) — not a second, parallel id. |
| `sourceSystem` | Real, captured from an optional `X-Source-System` request header, defaulting honestly to `"api"` when absent (never guessed further). |
| `createdFromIP` / `createdFromDevice` | Real, captured from the request — the identical `x-forwarded-for` → `req.ip` → `req.socket.remoteAddress` precedence `controllers/Auth.js`'s own `getRequestMeta` already uses for login/session auditing, reimplemented at the utils layer (the correct dependency direction — a controller should never be imported by a utility) rather than duplicated ad hoc per module. |

## Usage

```js
// models/SomeNewModel.js
import mongoose from "mongoose";
import { applyEnterpriseMetadata, exposeVersion } from "../utils/enterpriseMetadata.js";

const SomeNewSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  // ...entity-specific fields...
}, { timestamps: true });

SomeNewSchema.plugin(applyEnterpriseMetadata, { includeCompany: true });

SomeNewSchema.set("toJSON", {
  transform: (doc, ret) => {
    exposeVersion(doc, ret);
    return ret;
  }
});
```

```js
// controllers/SomeNewController.js
import { captureRequestMetadata } from "../utils/enterpriseMetadata.js";

const record = await SomeService.create(scope.tenantId, {
  ...req.body,
  ...captureRequestMetadata(req)
}, userId);
```

`applyEnterpriseMetadata` never overrides a field a schema already defines (`addIfMissing` checks `schema.path(...)` first) — applying it to an existing model's schema can't silently clobber a field that model already relies on.

## Adoption

Per the hardening phase's own stated approach — global standards first, module-by-module adoption after — **no existing model is retrofitted with this plugin in this pass**. It's real, tested (`tests/enterpriseMetadataStandard.test.js`), and ready for (a) every genuinely new model going forward, and (b) a deliberate, separate retrofit pass across existing models once the rest of the Enterprise Standards queue is far enough along that the retrofit only has to happen once.
