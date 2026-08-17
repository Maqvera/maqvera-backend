# Enterprise Standards

Global, cross-module architectural standards — the Enterprise Architecture Hardening Phase. Each standard is documented once here and referenced by every module, instead of each module re-documenting (and inevitably drifting on) its own version of the same concern. No business logic changes as part of this phase — these are additive conventions and reusable infrastructure a module opts into.

```
Enterprise Standards
├── 01 Standard Metadata          ✔ Done
├── 02 Optimistic Locking         ✔ Done
├── 03 Idempotency                ✔ Done
├── 04 Error Contract             ✔ Done
├── 05 Correlation IDs            ✔ Done
├── 06 Resilience (Retry/CB/DLQ)  ✔ Done
├── 07 Event Versioning           ✔ Done
├── 08 API Version Strategy       ✔ Done
├── 09 Pagination Contract        ✔ Done
├── 10 Soft Delete & Archival     ✔ Done
├── 11 Data Retention & Legal Hold ✔ Done
├── 12 File Storage Standard      ✔ Done
├── 13 Rate Limiting              ✔ Done
├── 14 Webhooks                   ✔ Done
├── 15 OpenAPI Standard           ✔ Done
└── 16 DDD Internal Domain Model  ✔ Done
```

## Progress

| # | Standard | Status |
|---|---|---|
| 1 | [Standard Metadata Model](./01-standard-metadata.md) | ✔ Done |
| 2 | [Optimistic Locking](./02-optimistic-locking.md) | ✔ Done |
| 3 | [Idempotency](./03-idempotency.md) | ✔ Done |
| 4 | [Error Contract](./04-error-contract.md) | ✔ Done |
| 5 | [Correlation IDs](./05-correlation-ids.md) | ✔ Done |
| 6 | [Resilience (Retry/Timeout/Circuit Breaker/DLQ)](./06-resilience.md) | ✔ Done |
| 7 | [Event Versioning](./07-event-versioning.md) | ✔ Done |
| 8 | [API Version Strategy](./08-api-version-strategy.md) | ✔ Done |
| 9 | [Pagination Contract](./09-pagination.md) | ✔ Done |
| 10 | [Soft Delete & Archival](./10-soft-delete-archival.md) | ✔ Done |
| 11 | [Data Retention & Legal Hold](./11-data-retention-legal-hold.md) | ✔ Done |
| 12 | [File Storage Standard](./12-file-storage.md) | ✔ Done |
| 13 | [Rate Limiting](./13-rate-limiting.md) | ✔ Done |
| 14 | [Webhooks](./14-webhooks.md) | ✔ Done |
| 15 | [OpenAPI / Swagger / SDK Generation](./15-openapi-sdk.md) | ✔ Done |
| 16 | [DDD Internal Domain Model](./16-ddd-domain-model.md) | ✔ Done |

Several items above already have a real, working implementation somewhere in this codebase — this phase's job for those is documenting them as a named, cross-module standard (and closing real gaps), never replacing something that already works.
