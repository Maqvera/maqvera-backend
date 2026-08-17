# Enterprise Identity & Global Resource ID Platform

A CORE platform (Improvement 5) that gives every business object a real, centrally-generated **Human Readable Number** and **Global Resource ID**, on top of its own MongoDB `_id`/UUID — "Nobody searches UUID. Everybody searches document number," exactly like SAP's `1900000021`, Oracle's `INV100012`, or Dynamics' `V000123`.

## Overview

Before this platform, human-readable document numbers already existed in this codebase, but only as private, hardcoded logic inside individual Finance services (`InvoiceService._generateInvoiceNumber`, and equivalents elsewhere) — one prefix, one format, calendar year only, no company/branch variation, and no admin-facing way to change the format. This platform is a real, standalone, tenant-configurable **Number Generator** any module can call through a real API, without touching or duplicating that existing Finance logic (see "Cross-Module Adoption" below for why it's left alone in this pass).

## Domain Model

| Model | Purpose |
|---|---|
| `NumberingSchemeModel` | The configurable **format** for one `resourceType` (optionally further scoped to a specific Company/Branch — Improvement 4's own descriptive hierarchy nodes, never an access-isolation dimension). `prefix`, `separator`, `includeYear`/`includeCompany`/`includeBranch`, `sequenceLength`, `fiscalYearStartMonth`, `allowGaps`, `isDefault`. |
| `ResourceSequenceModel` | The atomic counter — `findOneAndUpdate($inc)`, the exact same proven pattern as the pre-existing `FinanceSequenceModel` (kept separate; see below), keyed by `(tenantId, schemeId, key)` where `key` is the fiscal-year reset bucket. |
| `GeneratedNumberModel` | The real Resource Registry — every number ever issued, its `documentNumber`, its `globalResourceId`, and (once known) the internal `resourceUuid` it belongs to. Backs `GET /api/v1/numbering/history` and the "Never Expose Internal Database Keys" rule. |

## Global Resource ID

```
{tenantSegment}[-{legalEntityCode}]-{documentNumber}
```

e.g. `MAQVERA-LE-4821-INV-2027-000145`. `tenantSegment` is derived directly from the caller's own `tenantId` (== `TenantModel.tenantKey` throughout this codebase) — no second tenant-code registry invented on top of Improvement 4's own Organisation platform. `legalEntityCode` (from `LegalEntityModel`, Improvement 4) is included only when resolvable — explicitly passed, or auto-resolved from a supplied `companyId` via `CompanyModel.legalEntityId`. A tenant that hasn't adopted the Organisation hierarchy still gets a real, globally-unique Global Resource ID, just without the legal-entity segment.

`documentNumber` is unique **per tenant** (two tenants both minting `INV-2027-000001` is expected and correct). `globalResourceId` is unique **across every tenant** — that is its entire purpose. Both uniqueness constraints are **partial indexes that exclude `RolledBack` rows** — a rolled-back reservation keeps its historical string for audit, while the reclaimed sequence value can back a brand-new row with that same string once `allowGaps: false` reclaims it (see below).

## Scheme Resolution (`NumberGeneratorService._resolveScheme`)

`generateNumber({ resourceType, companyId, branchId })` resolves, in order: an exact company+branch scheme → a company-only scheme → the tenant's explicit `isDefault` scheme for that `resourceType` → a plain tenant-wide scheme. No match → an honest `Error` naming the missing `resourceType`, never a fabricated fallback format.

## Gap-Aware Sequencing

- **`allowGaps: true`** (default) — a reserved-but-unused number is a permanent gap, standard accounting-document behavior. `rollbackSequence` is rejected outright for these schemes.
- **`allowGaps: false`** — `POST /:generatedNumberId/rollback` performs a **compare-and-decrement**: the underlying counter only rewinds if nothing has claimed a later number since (`ResourceSequenceModel.rollbackIfUnclaimed`). If something else already raced ahead, the rollback still marks the row `RolledBack` but the integer stays a gap — honest best-effort reclaim, never a fabricated distributed-transaction guarantee.

## Reserved → Registered Lifecycle

`generateNumber` without a `resourceUuid` returns a `"Reserved"` row (the common "I need the number before the document exists yet" case). `POST /:generatedNumberId/register` later attaches the real internal id (`"Registered"`, fires `ResourceRegistered`) — idempotent for the same `resourceUuid`, rejected for a conflicting one or an already-`RolledBack` row.

## Domain Events

`NumberSchemeCreated`, `NumberSchemeUpdated`, `NumberGenerated`, `SequenceReserved`, `ResourceRegistered`, `SequenceRolledBack`, `SequenceReset`.

## API Endpoints (`/api/v1/numbering`)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/schemes` | `numbering.manage` | Create a numbering scheme |
| GET | `/schemes` | `numbering.read` | List schemes (`?resourceType=`, `?companyId=`, `?branchId=`) |
| GET | `/schemes/:schemeId` | `numbering.read` | Get one scheme |
| PATCH | `/schemes/:schemeId` | `numbering.manage` | Update a scheme |
| POST | `/schemes/:schemeId/reset` | `numbering.manage` | `SequenceReset` — admin override of a sequence bucket |
| POST | `/generate` | `numbering.generate` | Mint the next number for a `resourceType` |
| POST | `/:generatedNumberId/register` | `numbering.generate` | Attach the real internal `resourceUuid` |
| POST | `/:generatedNumberId/rollback` | `numbering.generate` | Void a Reserved number (`allowGaps: false` schemes only) |
| GET | `/history` | `numbering.read` | The Resource Registry (`?resourceType=`, `?resourceUuid=`, `?documentNumber=`) |

`numbering.generate` is deliberately separate from `numbering.manage` — any authorized user creating a business document should be able to trigger number generation without holding scheme-admin rights.

## Cross-Module Adoption

This pass builds the core Number Generator standalone. It does **not** rewire existing Finance services' own hardcoded `_generateXNumber` methods (Invoice/Journal/Receipt/etc., all still backed by the pre-existing `FinanceSequenceModel`) onto this platform, and does not yet add `documentNumber`/`globalResourceId` fields to existing business models (Invoice, Payment, Expense, Vendor, Customer, Journal, Forecast, Budget). Both are real, deliberate, separate follow-up work — a large, cross-cutting adoption effort per existing document type, not attempted here.
