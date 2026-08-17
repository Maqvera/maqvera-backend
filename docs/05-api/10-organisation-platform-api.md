# Enterprise Organisation Structure Platform

A CORE platform (Improvement 4) that gives the hierarchy vocabulary already scattered across this codebase — Tenant, Company, Branch, Department — an officially defined shape, so every module built afterward references it the same way instead of each developer assuming their own relationship between these terms.

## Overview

Before this platform, `tenantId`/`companyId`/`branchId`/`departmentId` appeared throughout the codebase with no defined relationship: "Can one company have multiple branches? Can HR see another company? Can Finance post across legal entities?" had no answer beyond a given developer's assumption. This platform answers it with a real, backed hierarchy:

```
Tenant (security boundary)
  -> Organisation (business group, e.g. "ABC Group")
    -> Legal Entity (registered company, its own tax number/financial statements, e.g. "ABC Builders LLC")
      -> Business Unit (operational division, NOT a legal company, e.g. "Construction BU") [optional]
      -> Company (operational company inside the ERP, e.g. "ABC Builders Karachi")
        -> Branch (physical office, e.g. "Karachi Head Office") [descriptive only]
          -> Department (e.g. "Finance")
            -> Team (e.g. "Accounts Team") [optional]
```

**Tenant remains the only data-isolation boundary in this codebase** (`utils/accessScope.js`, `docs/06-external-integrations/03-final-architecture-no-branches-rbac.md`) — nothing in this platform changes that. Every entity above is tenant-owned business data, scoped by `tenantId` like any other tenant-owned collection, resolved from `getAccessScope(req)` exactly the same way `CustomerController.js`/`BookingController.js` already do. None of them — Branch included — is a second access-control dimension. Branch specifically was previously removed as an *isolation* boundary (`scripts/migrateRemoveBranchId.js`) and stays removed as one; it is rebuilt here purely as a descriptive hierarchy node (a Company's physical office), never consulted by `getAccessScope()` or any hand-rolled access filter.

`Company` in this platform is a **new, lower-level operational entity**, not to be confused with this codebase's own pre-existing "Company = Tenant" shorthand describing the tenant as a whole. A tenant that never adopts this hierarchy (the common case for existing tenants) is completely unaffected — every field this platform adds anywhere is optional/nullable, and no pre-existing query changes behavior.

## Domain Model

| Model | File | Purpose |
|---|---|---|
| `OrganisationModel` | `models/OrganisationModel.js` | Business group directly under Tenant. |
| `LegalEntityModel` | `models/LegalEntityModel.js` | Registered company — its own `registrationNumber`/`taxNumber`/`reportingCurrency`. `Pending` until both are on file, then `Active` via `LegalEntityActivated`. |
| `BusinessUnitModel` | `models/BusinessUnitModel.js` | Operational division under a Legal Entity (`organisationId` denormalized from it). |
| `CompanyModel` (`org_company`) | `models/CompanyModel.js` | Operational company under a Legal Entity, optionally tagged to one Business Unit. |
| `BranchModel` (`org_branch`) | `models/BranchModel.js` | Physical office under a Company. **Descriptive only** — see Overview. |
| `Departmentmodel.js` (existing, extended) | `models/Departmentmodel.js` | Pre-existing model (already referenced by `EmployeeProfileModel`). Gained optional `companyId`/`branchId` links; its own `active/inactive/suspended/deleted` status enum is untouched. |
| `TeamModel` | `models/TeamModel.js` | Leaf node under Department. |

Every model: `optimisticConcurrency: true`, a `timeline[]` audit trail, `createdBy`/`updatedBy`, and a real generated code (`ORG-1234`, `LE-1234`, etc. — prefixes configurable via `utils/organisationConfig.js`).

## Validation Chain (`services/OrganisationService.js`)

Every create/reparent call runs through `OrganisationService._assertParent`: the declared parent must (1) exist, (2) belong to the **same tenant** as the caller, and (3) not be `Closed`/`deleted` — a closed parent cannot accept new children. This is the real implementation of the spec's "Validate Entire Organisation Hierarchy" rule:

```
Authentication (JWT) -> Tenant (getAccessScope) -> Organisation -> Legal Entity
  -> [Business Unit] -> Company -> Branch -> Permission (req.auth.permissions) -> Business Logic
```

A `businessUnitId` supplied on `POST /companies` is additionally checked against the supplied `legalEntityId` — a real business unit that belongs to a *different* legal entity is rejected, not silently accepted.

## Domain Events (`utils/eventBus.js`)

`OrganisationCreated`, `OrganisationUpdated`, `LegalEntityCreated`, `LegalEntityUpdated`, `LegalEntityActivated`, `BusinessUnitCreated`, `BusinessUnitUpdated`, `CompanyCreated`, `CompanyUpdated`, `BranchCreated`, `BranchUpdated`, `BranchClosed`, `DepartmentCreated`, `DepartmentUpdated`, `TeamCreated`, `TeamUpdated`.

## API Endpoints (`/api/v1`)

All routes require `authenticateAccessToken`; every handler additionally checks `req.auth.permissions` for the listed key (or `admin`).

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/organisations` | `organisation.manage` | Create an organisation |
| GET | `/organisations` | `organisation.read` | List the tenant's organisations |
| GET | `/organisations/:organisationId` | `organisation.read` | Get one organisation |
| PATCH | `/organisations/:organisationId` | `organisation.manage` | Update name/description/industry/status |
| POST | `/legal-entities` | `legalentity.manage` | Create a legal entity under an organisation |
| GET | `/legal-entities` | `legalentity.read` | List legal entities (`?organisationId=`) |
| GET | `/legal-entities/:legalEntityId` | `legalentity.read` | Get one legal entity |
| PATCH | `/legal-entities/:legalEntityId` | `legalentity.manage` | Update a legal entity |
| POST | `/legal-entities/:legalEntityId/activate` | `legalentity.manage` | Pending -> Active (requires registrationNumber + taxNumber on file) |
| POST | `/business-units` | `businessunit.manage` | Create a business unit under a legal entity |
| GET | `/business-units` | `businessunit.read` | List business units (`?legalEntityId=`) |
| GET | `/business-units/:businessUnitId` | `businessunit.read` | Get one business unit |
| PATCH | `/business-units/:businessUnitId` | `businessunit.manage` | Update a business unit |
| POST | `/companies` | `company.manage` | Create a company under a legal entity (+ optional business unit) |
| GET | `/companies` | `company.read` | List companies (`?legalEntityId=`, `?businessUnitId=`) |
| GET | `/companies/:companyId` | `company.read` | Get one company |
| PATCH | `/companies/:companyId` | `company.manage` | Update a company |
| POST | `/branches` | `branch.manage` | Create a branch under a company |
| GET | `/branches` | `branch.read` | List branches (`?companyId=`) |
| GET | `/branches/:branchId` | `branch.read` | Get one branch |
| PATCH | `/branches/:branchId` | `branch.manage` | Update a branch |
| POST | `/branches/:branchId/close` | `branch.manage` | `BranchClosed` |
| POST | `/departments` | `department.manage` | Create a department (optional `companyId`/`branchId`) |
| GET | `/departments` | `department.read` | List departments (`?companyId=`, `?branchId=`) |
| GET | `/departments/:departmentId` | `department.read` | Get one department |
| PATCH | `/departments/:departmentId` | `department.manage` | Update a department |
| POST | `/teams` | `team.manage` | Create a team under a department |
| GET | `/teams` | `team.read` | List teams (`?departmentId=`) |
| GET | `/teams/:teamId` | `team.read` | Get one team |
| PATCH | `/teams/:teamId` | `team.manage` | Update a team |

## Cross-Module Adoption

This pass builds the core hierarchy only. Threading `organisationId`/`legalEntityId`/`businessUnitId`/`companyId`/`branchId`/`departmentId`/`teamId` through existing modules (Payment, Finance, HR, Booking, etc.) where each is actually relevant — never adding every ID to every model — is a deliberate, separate follow-up pass, not attempted here.
