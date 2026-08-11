---
title: Finance API
document_id: API-008
version: 1.0.0
status: Draft
module: Finance
---

# Finance API

# Part 1 — Finance Module Foundation

## Overview

The Finance module is responsible for managing all financial operations across the ERP.

Unlike standalone accounting software, this Finance module is tightly integrated with CRM, Booking, Travel, Visa, Procurement, HR, Inventory, and other business domains.

Financial transactions are generated automatically from business events whenever possible. Manual accounting entries are supported only where appropriate.

The module follows double-entry accounting principles and maintains an immutable financial ledger.

---

# Business Goals

✓ Double Entry Accounting

✓ Multi-Currency

✓ Multi-Tenant

✓ Automated Journal Entries

✓ Tax Management

✓ Discount Engine

✓ Settlement Engine

✓ Financial Approval Workflow

✓ Audit Trail

✓ Regulatory Compliance

✓ AI Assisted Financial Analysis

**Note on scope vs. the original spec:** the originating spec draft for this module listed "Multi-Branch" as a goal (branch-specific reports, profitability, cash flow, approvals, and a branch prefix in document numbering). This codebase has no branch concept anywhere — Company = tenant is the *only* data-isolation boundary (see [`docs/06-external-integrations/03-final-architecture-no-branches-rbac.md`](../06-external-integrations/03-final-architecture-no-branches-rbac.md)). Every branch-scoped item from the spec is implemented tenant-scoped instead; nothing in Finance adds a `branchId` field, filter, or endpoint.

---

# High-Level Architecture

```
Business Modules
      |
      v
Financial Event
      |
      v
Accounting Engine
      |
      v
Journal Entry
      |
      v
Ledger
      |
      v
Financial Reports -> Dashboard -> Analytics
```

---

# Business Domains Connected

CRM, Booking, Travel, Visa, Inventory, Purchasing, Sales, HR, Payroll, Assets, Subscriptions, Communication, AI.

Every module may generate financial transactions.

---

# Core Finance Components

Chart Of Accounts, General Journal, General Ledger, Accounts Receivable, Accounts Payable, Invoices, Payments, Receipts, Refunds, Bank Accounts, Cash Accounts, Expenses, Taxes, Discounts, Financial Workflow, Settlement, Reporting, Analytics, Search, Audit.

---

# Accounting Principles

Double Entry Accounting — every transaction must balance:

```
Debit Total = Credit Total
```

Unbalanced journals are never allowed to post.

---

# Financial Lifecycle

```
Business Event -> Financial Validation -> Journal Generation -> Approval (Optional)
   -> Ledger Posting -> Reporting -> Analytics -> Audit
```

---

# Example

```
Visa Invoice Created
      |
      v
  Debit: Accounts Receivable
      |
      v
  Credit: Visa Revenue
      |
      v
  Ledger Updated -> Dashboard Updated
```

---

# Finance Boundaries

**Finance owns:** Financial Transactions, Journal Entries, Ledger, Taxes, Payments, Refunds, Banking, Reports.

**Finance does NOT own:** Customers, Bookings, Visa Cases, Travel Packages, Documents. Those remain in their respective modules.

---

# Integration Strategy

Business modules never update financial tables directly. Instead they publish financial events (`utils/eventBus.js`); Finance consumes those events and creates accounting entries.

```
Booking Created -> BookingConfirmed Event -> Finance Service -> Generate Invoice
   -> Generate Journal -> Post Ledger -> Publish AccountingCompleted Event
```

---

# Core Design Principles

Configuration Driven, Event Driven, Immutable Ledger, Double Entry, Audit First, Read Optimized Reporting, CQRS Ready, Multi Tenant, Cloud Native.

---

# Multi Tenant Strategy

Every financial record contains `tenantId`. Every query is filtered by tenant via `getAccessScope(req)` (`utils/accessScope.js`) — no shared accounting data across tenants, and no hand-rolled tenant filters.

---

# Multi Currency Strategy

Transactions are stored using Transaction Currency, Base Currency, Exchange Rate, and Converted Amount. Historical rates are preserved. Currency support is shared with the Booking module's currency catalog (`utils/bookingConfig.js` `supportedCurrencies`/`defaultCurrency`) rather than duplicated, so the ERP has one currency source of truth.

---

# Financial Document Types

Quotation, Invoice, Receipt, Payment, Refund, Credit Note, Debit Note, Expense, Journal Voucher, Bank Transfer, Adjustment, Settlement. All document types configurable.

---

# Financial Numbering

Every financial document has a Document Number, Financial Year, and Sequence Number (Company/tenant-scoped — no branch prefix). Numbering is configurable per document type; the exact format is defined when each document type (Invoice, Journal Voucher, ...) is implemented in a later part.

---

# Status Strategy

Draft, Pending Approval, Approved, Posted, Cancelled, Voided, Archived. Statuses configurable.

---

# AI Coding Rules

✓ Double Entry Only

✓ Immutable Ledger

✓ Event Driven

✓ Multi Currency

✓ Tenant Isolation

✓ Audit Logging

✓ Soft Delete (Except Ledger)

✓ Configuration Driven

✓ CQRS Ready

---

# Domain Events (Module-Wide)

`InvoiceCreated`, `InvoiceApproved`, `PaymentReceived`, `ReceiptGenerated`, `ExpenseCreated`, `JournalPosted`, `LedgerUpdated`, `RefundProcessed`, `SettlementCompleted`, `FinancialPeriodClosed`.

---

# Enterprise Architecture

```
Business Modules -> Financial Event Bus -> Accounting Engine
                                               |
                          +--------------------+--------------------+
                          v                    v                    v
                       Journal            Tax Engine          Discount Engine
                          |
                          v
                   General Ledger -> Reporting Engine -> Dashboard -> AI Analytics
```

## Accounting Engine (design direction)

Rather than letting every business module write its own journal entries directly, financial-effect modules (Booking, Visa, Travel, Inventory, HR, ...) publish domain events; a centralized Accounting Engine (Journal Generator, Posting Engine, Tax Engine, Currency Engine, Approval Engine, Settlement Engine, Audit Engine, Event Publisher) is the single authoritative source that turns those events into standardized journal entries against the Chart of Accounts below. This keeps accounting rules centralized and consistent, and lets future modules integrate without redesigning Finance. The Accounting Engine itself (event subscribers, journal generation) ships with the General Journal module (Part 3) — Part 2 only establishes the account structure it will post against.

---

# Part 2 — Chart of Accounts (COA) APIs

## Overview

The Chart of Accounts (COA) defines the complete financial account structure used throughout the ERP. Every financial transaction ultimately posts to one or more accounts defined here. The COA is configurable, hierarchical (unlimited depth, capped at `MAX_ACCOUNT_HIERARCHY_DEPTH` as a safety bound — see `utils/financeConfig.js`), and tenant-scoped.

**Tenant-only, not branch-scoped:** the originating spec listed "Branch Isolation" and a query-string `branch` filter for this module. Neither exists in the implementation — every account is scoped by `tenantId` only, and account numbering has no branch prefix. See Part 1's scope note above.

## Account Categories

Assets, Liabilities, Equity, Revenue, Expense — configurable via `ACCOUNT_CATEGORIES_JSON` (`utils/financeConfig.js`).

## Account Types

Header, Posting, Control, Summary, System, Temporary, Virtual — configurable via `ACCOUNT_TYPES_JSON`. Accounts of type Header/Summary/Virtual default `allowPosting` to `false` when the caller doesn't specify it; all other types default to `true`.

## Account Status

Draft, Active, Inactive, Archived — configurable via `ACCOUNT_STATUSES_JSON`.

## Hierarchy Model

Each account stores `parentId` (direct parent) plus a materialized `ancestors` array (root-to-parent `_id` chain) and `level`. This makes cycle detection and future subtree queries O(1)/indexed rather than requiring a parentId walk at request time. Moving an account to a new parent cascades `ancestors`/`level` recomputation to every existing descendant in the same operation.

---

# Endpoint Contract: GET /api/v1/accounts

## Business Purpose
Returns the tenant's Chart of Accounts.

## Permission
`finance.account.read` (or `finance.read`, or `admin`)

## Query Parameters
- `category`
- `parentId` (omit for all levels; `null`/`root`/empty string for top-level accounts only)
- `status`
- `currency`
- `page`
- `pageSize`
- `sort` (field name; prefix with `-` for descending — defaults to `accountCode` ascending)

## Response Includes
Paginated `items[]`, each with: Account ID, Account Code, Name, Description, Category, Type, Parent Account, Ancestors, Level, Status, Currency, Allow Posting, Is System Account, Has Posted Transactions, Tags, Created/Updated timestamps. Plus `pagination` (`total`, `page`, `pageSize`, `totalPages`).

## Business Rules
- Tenant Isolation (`getAccessScope(req)`)
- Pagination (bounded by `MAX_ACCOUNT_PAGE_SIZE`)
- Filtering
- Sorting

---

# Endpoint Contract: GET /api/v1/accounts/{accountId}

## Business Purpose
Returns a single account.

## Permission
`finance.account.read` (or `finance.read`, or `admin`)

## Business Rules
- 404 (`"Account not found."`) when the id doesn't exist or belongs to another tenant.

---

# Endpoint Contract: POST /api/v1/accounts

## Business Purpose
Creates a new account.

## Permission
`finance.account.create` (or `admin`)

## Request Example
```json
{
  "accountCode": "110101",
  "name": "Cash In Hand",
  "category": "Assets",
  "parentId": "665f1a2b3c4d5e6f7a8b9c0d",
  "allowPosting": true
}
```

## Business Workflow
```
Validate Account Code (unique per tenant)
      |
      v
Validate Parent (exists, same tenant)
      |
      v
Validate Category (Joi, config-driven)
      |
      v
Compute Hierarchy (level, ancestors) + Max-Depth Check
      |
      v
Create Account
      |
      v
Audit
      |
      v
Publish AccountCreated
      |
      v
Return Success
```

## Validation Rules
- Unique Account Code (per tenant)
- Parent Exists (same tenant)
- Valid Category / Type / Status / Currency (config-driven enum)
- Tenant Match
- `isSystemAccount` is never accepted from the request body — system accounts are provisioned only by trusted server-side bootstrap code, never through this public endpoint.

## Domain Events
- `AccountCreated`

---

# Endpoint Contract: PATCH /api/v1/accounts/{accountId}

## Business Purpose
Updates account information.

## Permission
`finance.account.update` (or `admin`)

## Editable Fields
Name, Description, Status, Parent, Currency, Allow Posting, Tags.

`accountCode` and `category` are immutable after creation — not accepted by this endpoint at all (`accountCode` is also schema-level `immutable` in Mongoose as a second guarantee).

## Business Rules
- System accounts (`isSystemAccount: true`) reject every edit.
- Currency cannot change once `hasPostedTransactions` is true.
- Reparenting validates the new parent exists (same tenant), rejects cycles (new parent cannot be a descendant of the account being moved), enforces `MAX_ACCOUNT_HIERARCHY_DEPTH`, and cascades `ancestors`/`level` recomputation to every existing descendant.

## Domain Events
- `AccountUpdated`
- `AccountHierarchyChanged` (only when `parentId` actually changes)

---

# Endpoint Contract: DELETE /api/v1/accounts/{accountId}

## Business Purpose
Deactivates an account (soft delete only — no account document is ever hard-deleted).

## Permission
`finance.account.delete` (or `admin`)

## Business Rules
- Soft delete only: sets `status` to `Inactive`.
- System accounts cannot be deactivated.
- Accounts with `hasPostedTransactions: true` cannot be deactivated ("Accounts with journal entries cannot be removed"). This flag is set by the Journal/Posting Engine (Part 3) the first time a journal line posts to the account — `ChartOfAccountService.markAsPosted()` is the integration point Part 3 will call.
- Accounts that still have child accounts cannot be deactivated (would orphan the hierarchy) — reassign or archive children first.
- Audit mandatory.

## Domain Events
- `AccountDeactivated`

---

# Account Numbering

Example hierarchical numbering convention (caller-assigned, not auto-generated — the COA numbering scheme is a tenant's own chart design):

```
100000  Assets
110000  Current Assets
111000  Cash
111100  Cash In Hand
111200  Petty Cash
```

---

# Control Accounts

Examples: Accounts Receivable, Accounts Payable, Tax Payable, Inventory, Bank. Modeled as ordinary accounts with `type: "Control"`; whether manual posting is allowed is governed per-account by `allowPosting`.

---

# System Accounts

Examples: Retained Earnings, Sales Revenue, Tax, Discount, Exchange Gain, Exchange Loss, Opening Balance, Suspense Account. Modeled as ordinary accounts with `isSystemAccount: true`, which is what actually grants the protection (not the `type` value) — protected from every edit and from deletion. Provisioned by trusted server-side bootstrap/seed code only; not creatable or promotable via the public API.

---

# Automatic Account Mapping

```
Invoice Created   -> Debit Accounts Receivable / Credit Sales Revenue
Payment Received  -> Debit Cash / Credit Accounts Receivable
Expense Created   -> Debit Expense Account / Credit Cash or Payable
```

This mapping (which account a given business event posts to) is the responsibility of the Account Mapping Engine inside the Accounting Engine, delivered with the General Journal module (Part 3) — Part 2 only defines the accounts that mapping rules will target, so business events never hardcode an account id.

---

# Domain Events (Part 2 Summary)

`AccountCreated`, `AccountUpdated`, `AccountDeactivated`, `AccountHierarchyChanged`.

Not yet implemented (require the Journal Engine / Part 3 to have meaning): `AccountActivated` (reactivation flow), `AccountMapped` (Account Mapping Engine).

---

# Part 3 — General Journal APIs

## Overview

The General Journal records every financial transaction — automatic or manual — before it posts to the General Ledger. The Journal Engine validates double-entry balance, financial-period status, and account postability before anything reaches the ledger. A journal is immutable once `Posted`; corrections happen only via a reversing journal.

**Tenant-only, not branch-scoped** — same override as Parts 1/2: the spec's "Branch Isolation" and "Branch Match" validation rule are dropped; journal numbering has no branch prefix.

## Journal Types / Statuses (config-driven — `utils/financeConfig.js`)

- **Types**: Manual, Automatic, Recurring, Adjustment, Opening Balance, Closing, Reversal, Exchange Rate Adjustment, Year End Closing (`JOURNAL_TYPES_JSON`).
- **Statuses**: Draft, Pending Approval, Approved, Posted, Rejected, Cancelled, Archived (`JOURNAL_STATUSES_JSON`).

## Endpoint contract gaps filled

The spec's Journal Lifecycle diagram names `Pending Approval`, `Rejected`, and `Cancelled` states, and the Domain Events list includes `JournalReversed`, but only five endpoints were explicitly contracted (list, create, update, approve, post) — with no endpoint to reach `Rejected`, `Cancelled`, or a reversal. Implemented as real, reachable behavior rather than left as unreachable states:

- `POST /api/v1/journals/{journalId}/reject` — reaches `Rejected` / fires `JournalRejected`.
- `POST /api/v1/journals/{journalId}/cancel` — reaches `Cancelled` / fires `JournalCancelled` (a name not in the original spec list, added for symmetry with `reject`).
- `POST /api/v1/journals/{journalId}/reverse` — required for the spec's own "Corrections are performed through reversing journals" principle (and Part 4's identical principle) to mean anything; fires `JournalReversed`.
- No separate "submit for approval" endpoint exists either, so `approve`/`reject` are valid directly from `Draft` (not only from `Pending Approval`) — bridging the missing transition rather than leaving `Pending Approval` unreachable.

## Approval Policy (scope decision)

The spec names policy categories ("No Approval / Single Approval / Dual Approval / Finance Manager / CFO Approval / Amount Based Approval") without concrete thresholds or role names to wire against this codebase's actual permission keys. Implemented as a single configurable gate: `JOURNAL_APPROVAL_REQUIRED` (default `true`). When `true`, `post` requires status `Approved` (i.e. must go through `/approve`, gated by `finance.journal.approve` — separation of duties). When `false`, `post` is also valid directly from `Draft`. The model's structure doesn't preclude a real multi-tier policy engine later; inventing amount tiers or a CFO role now would have been a guess.

## Financial Periods (shared with Part 4)

New: `models/FinancialPeriodModel.js` (tenant-scoped: `periodType`, `financialYear`, `startDate`, `endDate`, `status`). `FinancialPeriodService.assertPeriodOpen(tenantId, date)` is checked on journal create, update (when postingDate/lines change), post, and reverse. **A tenant with no periods configured is treated as permissively open** — this module doesn't yet ship period-management endpoints (none were contracted in Part 3/4), so blocking every posting for every tenant until periods exist would break the module outright. Once a tenant configures a period covering a date, its `Closed`/`Locked` status is enforced for real.

---

# Endpoint Contract: GET /api/v1/journals

## Permission
`finance.journal.read` (or `finance.read`, or `admin`)

## Query Parameters
`status`, `journalType`, `dateFrom`, `dateTo`, `currency`, `createdBy`, `page`, `pageSize`, `sort` (`branch` dropped per the tenant-only override)

## Business Rules
Tenant isolation, pagination, filtering, sorting. Posted journals appear here but are permanently locked against `PATCH`.

---

# Endpoint Contract: GET /api/v1/journals/{journalId}

## Permission
`finance.journal.read` (or `finance.read`, or `admin`)

---

# Endpoint Contract: POST /api/v1/journals

## Permission
`finance.journal.create`

## Request Example
```json
{
  "journalType": "Manual",
  "postingDate": "2027-01-10",
  "description": "Office Rent",
  "lines": [
    { "account": "Office Rent Expense", "debit": 5000 },
    { "account": "Cash", "credit": 5000 }
  ]
}
```
Each line accepts `accountId` (ObjectId, preferred/unambiguous), `accountCode`, or `account` (name) — resolved in that order (`accountId` -> exact `accountCode` -> case-insensitive exact name match). The `account`-by-name form matches the spec's own example; `accountId`/`accountCode` remain the robust choice for real integrations.

## Business Workflow
```
Validate Financial Period (must be Open or unconfigured)
      |
      v
Validate Accounts (exist in-tenant, status Active, allowPosting true)
      |
      v
Validate Debit Total = Credit Total (>= 2 lines, each exactly one side)
      |
      v
Generate Journal Number (JV-{year}-{6-digit atomic sequence}; JOURNAL_NUMBER_PREFIX configurable)
      |
      v
Create Journal (status: Draft)
      |
      v
Audit
      |
      v
Publish JournalCreated
      |
      v
Return Success
```

## Domain Events
`JournalCreated`

---

# Endpoint Contract: PATCH /api/v1/journals/{journalId}

## Permission
`finance.journal.update`

## Editable Fields
Description, Posting Date, Journal Lines, Attachments, Remarks.

## Business Rules
Only `Draft` journals editable — every other status is rejected outright. Changing `postingDate` or `lines` re-runs the financial-period and double-entry-balance validation exactly as `POST` does.

## Domain Events
`JournalUpdated`

---

# Endpoint Contract: POST /api/v1/journals/{journalId}/approve

## Permission
`finance.journal.approve`

## Business Rules
Valid from `Draft` or `Pending Approval` only.

## Domain Events
`JournalApproved`

---

# Endpoint Contract: POST /api/v1/journals/{journalId}/reject

## Permission
`finance.journal.approve`

## Request Body
`{ "reason": "..." }` (required)

## Domain Events
`JournalRejected`

---

# Endpoint Contract: POST /api/v1/journals/{journalId}/cancel

## Permission
`finance.journal.update`

## Business Rules
Valid from `Draft`, `Pending Approval`, or `Approved` only — never `Posted` (posting is irreversible; use `reverse` instead).

## Domain Events
`JournalCancelled`

---

# Endpoint Contract: POST /api/v1/journals/{journalId}/post

## Permission
`finance.journal.post`

## Business Workflow
```
Validate Status is Postable (Approved; or Draft too when JOURNAL_APPROVAL_REQUIRED=false)
      |
      v
Re-validate Financial Period (may have closed since creation/approval)
      |
      v
Lock Journal
      |
      v
Generate Ledger Entries (LedgerService.postJournalEntries — Part 4)
      |
      v
Audit
      |
      v
Publish JournalPosted
      |
      v
Return Success
```

## Business Rules
Posting is irreversible — no endpoint un-posts a journal. Corrections go through `reverse`.

## Domain Events
`JournalPosted`

---

# Endpoint Contract: POST /api/v1/journals/{journalId}/reverse

## Permission
`finance.journal.reverse`

## Business Purpose
Creates and immediately posts a new `journalType: "Reversal"` journal with each line's debit/credit swapped, linked to the original via `reversalOf`/`reversedBy`. The original journal is never edited — "Original journal always preserved."

## Request Body
```json
{
  "postingDate": "2027-01-15",
  "lines": [{ "lineId": "<original line _id>", "amount": 1000 }]
}
```
Omit `lines` entirely for a **complete** reversal (default — mirrors every original line 1:1). Supply `lines` for a **partial** reversal of specific original lines up to their originally-posted amount.

## Business Rules
Only a `Posted`, not-yet-reversed journal can be reversed. Financial period for the reversal's posting date is validated the same as any other posting.

## Domain Events
`JournalReversed`

---

# Journal Numbering

`{JOURNAL_NUMBER_PREFIX}-{financialYear}-{6-digit sequence}`, e.g. `JV-2027-000345` — no branch segment (spec's `JV-KHI-2027-000345` example had one). The sequence is a real atomically-incremented counter (`models/FinanceSequenceModel.js`, `findOneAndUpdate` with `$inc` — atomic even on a standalone, non-replica-set MongoDB), not the `countDocuments()`-based approximation used elsewhere in this codebase for lower-stakes numbering (e.g. `VisaService.generateCaseNumber`) — a numbering race here would misorder ledger postings, which this module exists specifically to prevent.

---

# Deferred (named in the spec, not built this pass)

- **Recurring Journals** (`RecurringJournalGenerated` event) — needs a scheduler (matching this codebase's existing `*Scheduler.js` pattern) plus a recurring-rule model with concrete frequency/field shapes, none of which were given in the contract. The `journalType: "Recurring"` value exists on the model so a future scheduler can tag what it generates.
- **Supporting Documents upload** — `attachments` is a real, editable array field (URL/filename/contentType), but no multipart-upload endpoint was contracted for Journal the way Part 2's spec implies for other document types; attach a URL from an already-uploaded file (`utils/fileStorage.js`) rather than uploading through this endpoint.
- **Multi-currency exchange-rate conversion on journal lines** — Part 1 names Transaction Currency/Base Currency/Exchange Rate/Converted Amount as a strategy, but no field shape was given at the line level; a journal's `currency` is a single value today, not per-line.

---

# General Ledger — Finance Module Part 4

## Overview

The General Ledger is the immutable, append-only result of posting a journal. `models/LedgerEntryModel.js` enforces immutability at the schema layer — Mongoose pre-hooks throw on every update/delete path (`updateOne`, `findOneAndUpdate`, `deleteOne`, `deleteMany`, `findOneAndDelete`, and `save()` on an existing document) — so "corrections via reversing journal only" isn't just a convention, it's structurally the only way to change ledger history.

**Tenant-only, not branch-scoped** — same override as every other Finance part; `branch` query params are dropped everywhere below.

## Posting Engine (`LedgerService.postJournalEntries`)

Invoked only by `JournalService.postJournal`/`reverseJournal` — there is no direct "create a ledger entry" endpoint by design (Finance's own Part 1 boundary: business modules/users never write ledger rows directly).

0. **Balance Validation** — independently re-sums the journal's own `debit`/`credit` lines and rejects an out-of-balance posting (`LedgerService.assertLinesBalance`) *before writing anything*. This duplicates JournalService's identical Part 3 check on purpose: the Ledger is the one place this codebase treats as truly immutable, so it never trusts an upstream caller (today only `JournalService`, but the check protects any future caller too) as the sole line of defense against posting a broken entry that could never be edited afterward.

For each journal line, sequentially:
1. Reads the account's latest ledger entry (highest `sequence`) for its previous balance.
2. Atomically reserves the next per-`(tenantId, accountId)` `sequence` (`FinanceSequenceModel`).
3. `openingBalance` = that previous balance; `runningBalance` (= this entry's closing balance) = `openingBalance + debit - credit` (raw, signed; category-aware presentation happens at the reporting layer, not storage). **Both are stored on the entry itself** — "Every ledger entry stores Opening Balance, Debit, Credit, Closing Balance... allows instant balance retrieval" — so a plain `GET /general-ledger` list never needs an extra lookup to show an entry's before/after balance.
4. Creates the `LedgerEntryModel` document and marks the account `hasPostedTransactions: true` (Part 2's `ChartOfAccountService.markAsPosted` — this is the integration point Part 2 was built to call).

Running balance order is **posting order** (`sequence`), not `postingDate` order — a backdated correction doesn't retroactively rewrite every later entry's stored `openingBalance`/`runningBalance`. This is exactly why the `/balance` and `/trial-balance` endpoints below don't trust those per-entry fields for arbitrary date-range queries — they recompute from raw ledger aggregation instead, so the posting-order simplification never produces a wrong answer for a date-scoped read, only a (cached) aggregation cost.

## Read Optimization

Account balance and trial balance responses are cached via the existing `CacheManager` abstraction (Redis if configured, in-memory fallback otherwise — never a new caching layer), short TTL (`ACCOUNT_BALANCE_CACHE_TTL_SECONDS`/`TRIAL_BALANCE_CACHE_TTL_SECONDS`, default 30s), invalidated on every posting and on `recalculate`. Materialized summary tables / read replicas (also named in the spec) are a further scaling step once real query volume justifies them — not built this pass.

---

# Endpoint Contract: GET /api/v1/general-ledger

## Permission
`finance.ledger.read` (or `finance.read`, or `admin`)

## Query Parameters
`accountId`, `dateFrom`, `dateTo`, `currency`, `journalNumber`, `referenceNumber`, `page`, `pageSize`, `sort` (`branch` dropped; default sort is chronological — `postingDate` then `sequence`, ascending)

## Response Includes
Ledger Entry ID, Posting Date, Journal Number, Account (`accountId`/`accountCode`), Debit, Credit, Opening Balance, Running/Closing Balance, Currency, Reference, Created Date — every field on the entry as posted (see Posting Engine above), no extra lookup required.

## Business Rules
Read-only, immutable records, tenant isolation, pagination, filtering, sorting.

---

# Endpoint Contract: GET /api/v1/general-ledger/{accountId}/balance

## Permission
`finance.ledger.read` (or `finance.read`, or `admin`)

## Query Parameters
`asOfDate` (optional; not explicitly listed in the original spec, added to actually fulfill its stated "Supports historical dates" business rule — omit for the current balance)

## Response Includes
Opening Balance, Debit Total, Credit Total, Closing Balance, Current Balance, Currency, Financial Period (the period record covering `asOfDate`/today, or `null` if the tenant hasn't configured one — Opening Balance is `0` in that case, i.e. the entire ledger history is treated as one continuous period).

## Business Rules
Balance is always computed from the immutable ledger via aggregation (cached at the response layer only), never from a mutable summary field — "Balance calculated from immutable ledger." Supports historical dates via `asOfDate`.

---

# Endpoint Contract: GET /api/v1/general-ledger/trial-balance

## Permission
`finance.ledger.read` (or `finance.read`, or `admin`)

## Query Parameters
`financialYear`, `currency`, `date` (`branch` dropped)

## Response Includes
`rows[]` (Account Code, Account Name, Category, Currency, Debit Balance, Credit Balance, **Net Balance**), `totalDebitBalance`, `totalCreditBalance`, `isBalanced`. Only accounts with actual ledger activity in range appear — matching how a real trial balance behaves.

## Domain Events
`TrialBalanceGenerated` — fired once per actual (non-cached) computation, not on every read.

## Business Rules
`Total Debits = Total Credits` is computed and returned as `isBalanced` on every response — a live integrity check, not an assumption. The Debit/Credit column split is category-independent (purely the sign of each account's net movement), which is what makes the total-debits-equal-total-credits invariant hold regardless of account mix — see `LedgerService.normalizeBalanceForCategory`'s doc comment for why an earlier category-based version of this function was wrong and got caught by its own unit test.

---

# Endpoint Contract: POST /api/v1/general-ledger/recalculate

## Permission
`admin` **only** — the spec states this explicitly ("Administrator only"), so it's gated on the `admin` permission directly rather than a granular `finance.*` key.

## Business Workflow
```
Invalidate cached account-balance entries for this tenant
      |
      v
Invalidate cached trial-balance entries for this tenant
      |
      v
Audit
      |
      v
Publish LedgerRecalculated
```

## Business Rules
"No ledger modification" — and none happens: `LedgerEntryModel` is schema-immutable, so recalculation cannot touch a stored entry even if it tried. Since every balance/trial-balance read already aggregates from the raw ledger rather than trusting a cached running-balance field, "recalculate" is genuinely just cache invalidation forcing the next read to recompute from source — not a placeholder. Runs synchronously today rather than as a queued background job; revisit if a future materialized-summary-table layer makes recomputation expensive enough to need one.

## Domain Events
`LedgerRecalculated`

---

# Deferred (named in the spec, not built this pass)

- **Year-End Closing automation** (closing journal generation, Profit/Loss transfer to Retained Earnings, new-year opening balances, historical-year locking) — a substantial feature in its own right; `FinancialPeriodModel.status` supports `Locked` today so a future closing engine has something real to set, but the engine itself isn't built.
- **Ledger Snapshots** (Daily/Monthly/Year-End) — the caching layer above serves the same "fast repeated reads" goal for now; dedicated snapshot documents are a later addition if cache TTLs prove insufficient at scale.
- **Materialized summary tables / read replicas** — see Read Optimization above.

---

# Domain Events (Parts 3 & 4 Summary)

`JournalCreated`, `JournalUpdated`, `JournalApproved`, `JournalRejected`, `JournalCancelled`\*, `JournalPosted`, `JournalReversed`, `LedgerEntryCreated`\*, `LedgerBalanceUpdated`\*, `TrialBalanceGenerated`, `LedgerRecalculated`.

\* Not in the original spec's Domain Events list — added because the corresponding endpoint/behavior needed one (`JournalCancelled`) or because the Posting Engine genuinely fires it (`LedgerEntryCreated`/`LedgerBalanceUpdated`, finer-grained than the spec's single `LedgerEntryCreated` mention).

Not yet implemented (require deferred features above to have meaning): `RecurringJournalGenerated`, `FinancialPeriodClosed`, `YearEndCompleted`, `LedgerSnapshotCreated`.

---

# Accounts Receivable — Finance Module Part 5

## Overview

"An Invoice is just a financial document. Accounts Receivable manages everything the customer still owes you." AR tracks a customer's outstanding balance from creation through settlement (payment, write-off, or credit), independent of the Invoice module that will eventually trigger it.

**Tenant-only, not branch-scoped** — same override as every other Finance part.

## The Invoice-module dependency, and how it's handled today

Part 5's own Overview diagram starts with "Invoice Created -> Accounts Receivable Created," and its Business Workflow for `allocate-payment` requires validating "Payment Exists." Neither an Invoice module nor a Payments module exists yet in this codebase (both are still unchecked further down this Progress list) — so two real gaps had to be closed, not guessed around:

- **No endpoint creates a receivable.** Part 5 contracts only `GET` (list), `GET /{id}`, and `POST /{id}/allocate-payment` — nothing to originate a receivable. Implemented both halves of Part 1's stated "Integration Strategy": `AccountsReceivableService.initEventListeners()` subscribes to `InvoiceCreated` right now (dormant until Part 7 ships and starts publishing it — zero code changes needed here when it does), **and** a pragmatic `POST /api/v1/accounts-receivable` endpoint for direct/manual creation today, so the module is actually usable and testable end-to-end before Part 7 exists. `revenueAccountCode` is this endpoint's own optional field (not in the spec) — supplying it posts a real creation-time journal (Debit AR control / Credit Revenue, Part 1's own worked example); omitting it skips that posting.
- **No Payments module exists to validate "Payment Exists" against.** Built `models/PaymentModel.js` — deliberately minimal at the time (amount, unallocated balance, method, currency, status) — plus a `POST /api/v1/payments` creation endpoint, existing only so AR's own contracted validation rule was real rather than skipped.
  > **Update (Part 7):** this minimal model was superseded by the real Enterprise Payment Engine — see Part 7 below. `AccountsReceivableService.allocatePayment` (this section) is unchanged in shape/behavior; it now calls the fuller `PaymentModel`/`PaymentService`, which is exactly the "specialized workflow on top of a shared engine" architecture Part 7's own spec calls for.

## Endpoint contract gaps filled

Beyond the above, the spec's own Receivable Lifecycle diagram and Domain Events list name states/events with no contracted endpoint to reach them:

- `POST /api/v1/accounts-receivable/{receivableId}/write-off` — reaches `Written Off` / fires `ReceivableWrittenOff`. "Management Approval" is enforced via the `finance.receivable.writeoff` permission gate (same pattern as Journal's single-tier approval), not a separate multi-step workflow. Posts a real journal (Debit Bad Debt Expense / Credit AR control) when both accounts are configured.
- `Overdue` and `In Collection` are **not** manual endpoints — they're detected automatically by `services/receivableOverdueScheduler.js` (a cron job, same shape as `documentExpiryScheduler.js`), matching the spec's own "Automatic Reminder" framing better than a manual trigger would. It also progresses `collectionStage` through the configured stages and publishes `NotificationRequested` for dunning — **never claiming an actual email/SMS/WhatsApp was sent**, since no notification provider is wired up anywhere in this codebase (identical, previously-established disclosure to `documentExpiryScheduler.js`'s own reminders).
- `Cancelled` and `Disputed` — no domain event names either state, and no endpoint was contracted. Left genuinely deferred rather than inventing an endpoint with nothing pointing at it; a `Cancelled` receivable most naturally arises from the future Invoice module voiding its source invoice, which doesn't exist yet either.

## Credit Limit

`models/CustomerCreditProfileModel.js` — Finance-owned, referencing `customer` by id only (Part 1: "Finance does NOT own Customers"; nothing was added to `CustomerModel`). `creditUsed` is never stored — it's the live sum of that customer's open receivable balances (`AccountsReceivableService.getCreditUsed`), so it can't drift out of sync with the receivables it reflects. A `creditLimit` of `0`/unset means unlimited (same "unconfigured = permissive" stance as Financial Periods); `AR_CREDIT_LIMIT_ENFORCEMENT` can disable the check entirely even where limits are set.

## Customer Credit (Overpayments)

`models/CustomerCreditModel.js`. On `allocate-payment`, if the allocated amount exceeds the receivable's outstanding balance, the excess is automatically credited to the customer (`CustomerCreditService.createCredit`, source `Overpayment`) — matching the spec's own worked example (Invoice 10,000, Payment 12,000 -> Outstanding 0, Customer Credit 2,000) exactly; see `computeOverpaymentSplit`'s test coverage. **Applying existing credit to a future receivable has no endpoint yet** — `remainingAmount` only decreases today through direct/administrative means, not a public API; deferred until that flow gets a concrete contract.

## Aging Analysis

No aging-report endpoint was contracted (Financial Reports/Analytics are their own, still-unbuilt future Parts) — instead, every list/detail response includes a live-computed `agingBucket` (`Current`/`1-30 Days`/.../`120+ Days`, `utils/financeConfig.js` `agingBuckets`) and `daysOverdue`, computed at read time rather than stored (so it's never stale).

## Cross-module wiring: Customer Timeline

`services/CustomerTimelineEventBus.js`'s own comment previously said Payments/Invoices were excluded "until those modules add a real customerId reference." `AccountsReceivableModel` now has one, and its events already carry `customerId` directly (no extra lookup needed, unlike the Booking event path) — so `ReceivableCreated`, `PaymentAllocated`, `ReceivablePaid`, `ReceivableOverdue`, `CollectionStarted`, and `ReceivableWrittenOff` are wired into the customer's cross-module timeline now.

## Deferred (named in the spec, not built this pass)

- **AI Insights** (Late Payment Risk, Collection Priority, Expected Payment Date, Customer Risk Score, Recommended Follow-up, Cash Flow Forecast) — "AI advisory only," which per this codebase's standing rules means a real LLM integration (prompt design, `AIToolRegistry` registration), not a hand-rolled heuristic dressed up as AI. That's its own focused piece of work, not something to bolt onto an already-large module; genuinely deferred rather than faked.
- **Multi-channel dunning delivery** (actually sending Email/SMS/WhatsApp/Phone Call) — no notification provider is integrated anywhere in this codebase; the scheduler publishes `NotificationRequested` with a `channel` hint (mirroring the Dunning Rules' own escalation order) for whatever eventually subscribes to send it.
- **Credit Notes integration** — `creditNoteIds` exists on the model, structurally ready, but the Credit Notes module itself is a separate, still-unbuilt Part.
- **Applying existing Customer Credit to a receivable** — see Customer Credit above.

---

# Endpoint Contract: GET /api/v1/accounts-receivable

## Permission
`finance.receivable.read` (or `finance.read`, or `admin`)

## Query Parameters
`customerId`, `status`, `currency`, `dueDateFrom`/`dueDateTo`, `overdue` (boolean — past-due + still-open shortcut), `page`, `pageSize`, `sort` (`branch` dropped)

## Response Includes
Receivable ID, Invoice Number, Customer, Issue Date, Due Date, Original Amount, Paid Amount, Outstanding Balance, Status, Currency, Created Date, plus computed `agingBucket`/`daysOverdue`.

## Business Rules
Filtering, pagination, sorting, tenant isolation.

---

# Endpoint Contract: GET /api/v1/accounts-receivable/{receivableId}

## Permission
`finance.receivable.read` (or `finance.read`, or `admin`)

## Response Includes
Customer, Invoice reference, Outstanding Balance, Payment History (`allocations[]`), Adjustments, Credit Notes (`creditNoteIds`, empty until that module ships), Timeline, Audit Summary.

---

# Endpoint Contract: POST /api/v1/accounts-receivable

*(Gap-fill — see "The Invoice-module dependency" above.)*

## Permission
`finance.receivable.create`

## Request Example
```json
{
  "customerId": "665f1a2b3c4d5e6f7a8b9c0d",
  "invoiceNumber": "INV-2027-000123",
  "dueDate": "2027-02-15",
  "originalAmount": 10000,
  "currency": "USD",
  "revenueAccountCode": "410000"
}
```
`invoiceNumber` is optional — omit it and one is generated (`AR-{year}-{6-digit sequence}`, same atomic `FinanceSequenceModel` used for journal numbering). `revenueAccountCode` is optional — see above for what supplying it does.

## Business Workflow
```
Validate Customer Exists
      |
      v
Validate Credit Limit (skipped if unconfigured or AR_CREDIT_LIMIT_ENFORCEMENT=false)
      |
      v
Resolve Invoice Number
      |
      v
Post Creation Journal (only if revenueAccountCode + AR_CONTROL_ACCOUNT_CODE configured)
      |
      v
Create Receivable
      |
      v
Audit
      |
      v
Publish ReceivableCreated
```

## Domain Events
`ReceivableCreated`

---

# Endpoint Contract: POST /api/v1/accounts-receivable/{receivableId}/allocate-payment

## Permission
`finance.receivable.update`

## Request Example
```json
{ "paymentId": "665f1a2b3c4d5e6f7a8b9c0d", "amount": 2500 }
```

## Business Workflow
```
Validate Payment Exists (and belongs to this receivable's customer)
      |
      v
Validate Currency Match
      |
      v
Split Amount (applied-to-receivable vs. overpayment excess)
      |
      v
Post Journal (Debit Cash / Credit AR control [/ Credit Customer Credit Liability])
      |
      v
Consume Payment's Unallocated Balance
      |
      v
Update Receivable Balance + Status
      |
      v
Create Customer Credit (only if overpayment)
      |
      v
Timeline + Audit
      |
      v
Publish PaymentAllocated (+ ReceivablePaid / ReceivableSettled as applicable)
```
Ledger posting (and therefore financial-period validation) happens **before** the payment/receivable are mutated — this codebase has no multi-document transactions anywhere, so that ordering is what keeps a closed-period or misconfigured-account failure from leaving inconsistent state.

## Business Rules
- "Unlimited allocations supported" — a receivable can receive allocations from many payments over time.
- Overpayment: the excess becomes Customer Credit automatically; only the amount actually needed to zero the receivable posts against AR.
- Rejected outright for a receivable already in a terminal status (`Paid`, `Settled`, `Written Off`, `Cancelled`).

## Domain Events
`PaymentAllocated`, `ReceivablePaid` (when the balance reaches zero via this payment), `ReceivableSettled` (whenever the balance reaches zero by any means — see Part 3/4's own note on why `Paid` and `Settled` are distinct signals).

---

# Endpoint Contract: POST /api/v1/accounts-receivable/{receivableId}/write-off

*(Gap-fill — see "Endpoint contract gaps filled" above.)*

## Permission
`finance.receivable.writeoff`

## Request Body
```json
{ "writeOffType": "BadDebt", "reason": "Customer declared bankruptcy" }
```
`writeOffType`: `SmallBalance` or `BadDebt`.

## Business Rules
Writes off the full remaining outstanding balance (no partial write-off shape was specified). Rejected for a terminal-status or already-zero-balance receivable. "Write offs never delete receivable history" — the receivable document, its full `allocations`/`timeline`/`adjustments` history, and the write-off's own audit trail all remain in place; only `status`/`outstandingBalance` change.

## Domain Events
`ReceivableWrittenOff`, `ReceivableSettled`

---

# Accounts Payable — Finance Module Part 6

## Overview

The mirror image of Accounts Receivable: "Vendor Invoice -> We Pay Supplier -> Balance becomes 0." AP tracks what the company owes a vendor from creation through settlement (payment or write-off).

**Tenant-only, not branch-scoped** — same override as every other Finance part.

## A deeper dependency gap than AR had, and how it's handled

AR (Part 5) could reference a real, already-existing `Customer`. AP has no equivalent — **no Vendor, Supplier, or Purchasing/Procurement module exists anywhere in this codebase**, and Part 6's own architecture diagram starts from a "Purchasing Module" that doesn't exist. Two things had to be built just to make AP referenceable at all, both deliberately minimal:

- `models/VendorModel.js` — name/contact/currency/payment-terms only. Same boundary discipline as `Customer` (Part 1: "Finance does NOT own Customers") — Vendor conceptually belongs to a future Purchasing domain; Finance references it by id, doesn't own it.
- `models/VendorPaymentModel.js` — the outbound mirror of Part 5's `PaymentModel.js`, kept as its own collection rather than repurposing the customer-side one (different real-world flow, different bank account, different reconciliation process — not just a relabeled copy).
  > **Update (Part 7): this file no longer exists.** Part 7's spec explicitly named this exact split (separate customer/vendor payment logic) as the anti-pattern to avoid — "keep them as specialized workflows built on top of the same Enterprise Payment Engine." `VendorPaymentModel`/`VendorPaymentService`/`VendorPaymentController` were deleted and `AccountsPayableService.allocatePayment` (this section) now calls the unified `PaymentService`, unchanged in its own shape/behavior. See Part 7 below for the full reasoning and what changed.

**Unlike AR, there is no upstream event to subscribe to.** AR's spec explicitly separated "Invoice Created" from "Accounts Receivable Created" as two steps, so `AccountsReceivableService` wires a dormant `InvoiceCreated` listener for when the Invoice module ships. Part 6's own Domain Events list has no `VendorInvoiceCreated` (or equivalent) at all — `PayableCreated` is presented as the entry point in its own right. So AP gets a `POST /api/v1/accounts-payable` creation endpoint (gap-fill, same reasoning as AR's) **without** a matching event-listener half, because there's no named event to listen for.

## Endpoint contract gaps filled

Only `GET` (list), `GET /{id}`, and `POST /{id}/allocate-payment` were contracted. Beyond creation (above), the spec's own Payable Lifecycle and Domain Events list name states/events with nothing to reach them:

- `POST /api/v1/accounts-payable/{payableId}/approve` — **AP has an approval gate AR never had.** The Lifecycle is `Draft -> Pending Approval -> Approved -> Open`, i.e. a payable must clear approval before it's payable at all. This endpoint transitions `Draft`/`Pending Approval` straight to `Open` (the actual pay-ready state) while still recording `approvedBy`/`approvedAt` and firing `PayableApproved` — the spec gives no distinct trigger or event between "Approved" and "Open," so they're treated as one real state with two spec-given labels rather than leaving "Open" unreachable behind an undefined second step.
- `POST /api/v1/accounts-payable/{payableId}/write-off` — reaches `Written Off` / fires `PayableWrittenOff`. "Management Approval" enforced via the `finance.payable.writeoff` permission gate, same pattern as every other write-off/approval gate in this Finance module. Ledger direction is the mirror-opposite of AR's own write-off: forgiving a liability is a *gain*, so this credits an income account (`VENDOR_WAIVER_INCOME_ACCOUNT_CODE`), not an expense one.
- `POST /api/v1/accounts-payable/{payableId}/schedule-payment` — reaches `VendorPaymentScheduled`, otherwise unfireable. Planning/visibility metadata only (`scheduledPayment.date`/`priority` on the payable) — **not** an automatic payment-execution engine, which would mean real bank-transfer integration, far outside this module's scope.

## Deliberate divergences from AR (not oversights)

- **No approval-less default status.** AR payables/receivables default to `Open`; AP payables default to `Draft`, matching the spec's own Lifecycle exactly (see the approval gate above).
- **No overdue scheduler.** AR's Lifecycle has `Overdue`/`In Collection` states with a dunning workflow (`receivableOverdueScheduler.js`). AP's own Lifecycle has neither — "Vendor Aging" is a live-computed read (`agingBucket`/`daysOverdue` on every response, via the same shared `computeAgingBucket` AR uses), never a status a payable transitions through. We don't send ourselves collection notices.
- **Advance Payments auto-apply at creation, not at allocation.** "Advance linked automatically when invoice arrives" — `AccountsPayableService.createPayable` calls `VendorCreditService.consumeAvailableCredits` immediately, applying any existing Active vendor credit (oldest first) to the brand-new payable before it's even returned to the caller. AR has no equivalent auto-apply-on-creation behavior (applying *existing* Customer Credit to a new receivable is explicitly deferred there) — this is a genuine, spec-driven asymmetry, not inconsistency.

## Shared implementation with AR

`computeAgingBucket` (`utils/agingUtils.js`) and `computeOverpaymentSplit`/`resolveStatusAfterPayment` (`utils/paymentAllocationUtils.js`) were extracted out of `AccountsReceivableService.js` into standalone utils during this pass specifically so Accounts Payable could reuse the identical math without either Finance service importing from the other. `AccountsReceivableService.js` still re-exports both names unchanged for backward compatibility.

## Deferred (named in the spec, not built this pass)

- **Purchase Matching (2-way/3-way)** — requires Purchase Orders and Goods Receipts, i.e. a real Purchasing/Procurement module, which doesn't exist. No `matchingType`/`matchingStatus` fields were added to the model either — inert placeholder fields with nothing to reference would be worse than admitting the feature isn't built. `VendorInvoiceMatched` is consequently not fireable.
- **Cash Flow Planning** (Upcoming/Overdue Payments, High Priority Vendors, Available Cash, Payment Forecast) — no endpoint was contracted; Financial Reports/Dashboard/Analytics are their own still-unbuilt future Parts. The underlying data (`scheduledPayment`, `agingBucket`) already exists on every payable, ready for that future reporting layer.
- **AI Insights** — same standing reasoning as AR Part 5: a real LLM integration is its own focused piece of work, not a heuristic dressed up as AI advisory.
- **Applying existing Vendor Credit to an already-open payable** (as opposed to a brand-new one) — only the at-creation auto-apply path exists; consuming credit against an existing payable's balance has no endpoint contract.

---

# Endpoint Contract: GET /api/v1/accounts-payable

## Permission
`finance.payable.read` (or `finance.read`, or `admin`)

## Query Parameters
`vendorId`, `status`, `currency`, `dueDateFrom`/`dueDateTo`, `overdue`, `page`, `pageSize`, `sort` (`branch` dropped)

## Response Includes
Payable ID, Vendor, Invoice Number, Invoice Date, Due Date, Original Amount, Paid Amount, Outstanding Balance, Status, Currency, Created Date, plus computed `agingBucket`/`daysOverdue` (Vendor Aging).

## Business Rules
Filtering, pagination, sorting, tenant isolation.

---

# Endpoint Contract: GET /api/v1/accounts-payable/{payableId}

## Permission
`finance.payable.read` (or `finance.read`, or `admin`)

## Response Includes
Vendor, Invoice reference, Payment History (`allocations[]`), Outstanding Balance, Adjustments (including auto-applied advances), Credit Notes (`creditNoteIds`, empty until that module ships), Timeline, Audit Summary.

---

# Endpoint Contract: POST /api/v1/accounts-payable

*(Gap-fill — see "A deeper dependency gap than AR had" above.)*

## Permission
`finance.payable.create`

## Request Example
```json
{
  "vendorId": "665f1a2b3c4d5e6f7a8b9c0d",
  "invoiceNumber": "VINV-2027-000045",
  "dueDate": "2027-03-01",
  "originalAmount": 100000,
  "currency": "USD",
  "expenseAccountCode": "510000"
}
```
`invoiceNumber` is optional — omit it and one is generated (`AP-{year}-{6-digit sequence}`). `expenseAccountCode` is optional — supplying it posts a real creation-time journal (Debit Expense / Credit AP control); omitting it skips that posting.

## Business Workflow
```
Validate Vendor Exists
      |
      v
Resolve Invoice Number
      |
      v
Post Creation Journal (only if expenseAccountCode + AP_CONTROL_ACCOUNT_CODE configured)
      |
      v
Create Payable (status: Draft)
      |
      v
Auto-Apply Available Vendor Credit/Advance
      |
      v
Audit
      |
      v
Publish PayableCreated
```

## Domain Events
`PayableCreated`

---

# Endpoint Contract: POST /api/v1/accounts-payable/{payableId}/approve

*(Gap-fill — see "Endpoint contract gaps filled" above.)*

## Permission
`finance.payable.approve`

## Business Rules
Valid from `Draft` or `Pending Approval` only. Transitions directly to `Open`.

## Domain Events
`PayableApproved`

---

# Endpoint Contract: POST /api/v1/accounts-payable/{payableId}/allocate-payment

## Permission
`finance.payable.update`

## Request Example
```json
{ "paymentId": "665f1a2b3c4d5e6f7a8b9c0d", "amount": 15000 }
```

## Business Workflow
```
Validate Payment Exists (and belongs to this payable's vendor)
      |
      v
Validate Currency Match
      |
      v
Split Amount (applied-to-payable vs. overpayment excess)
      |
      v
Post Journal (Debit AP control [+ Debit Vendor Advance Asset] / Credit Cash)
      |
      v
Consume Payment's Unallocated Balance
      |
      v
Update Payable Balance + Status
      |
      v
Create Vendor Credit (only if we overpaid the vendor)
      |
      v
Timeline + Audit
      |
      v
Publish VendorPaymentAllocated (+ PayablePaid / VendorSettlementCompleted as applicable)
```
Same pre-mutation ledger-posting ordering as AR, for the same reason (no multi-document transactions anywhere in this codebase).

## Business Rules
- Only `Open`/`Partially Paid` payables accept an allocation — `Draft`/`Pending Approval` must clear `approve` first.
- "Unlimited allocations supported."
- Overpaying a vendor creates Vendor Credit for the excess automatically (mirrors AR's overpayment handling exactly, opposite party).

## Domain Events
`VendorPaymentAllocated`, `PayablePaid` (balance reaches zero via this payment), `VendorSettlementCompleted` (balance reaches zero by any means)

---

# Endpoint Contract: POST /api/v1/accounts-payable/{payableId}/write-off

*(Gap-fill.)*

## Permission
`finance.payable.writeoff`

## Request Body
```json
{ "writeOffType": "VendorWaiver", "reason": "Vendor forgave remaining balance" }
```
`writeOffType`: `SmallBalance`, `VendorWaiver`, or `AccountingAdjustment`.

## Business Rules
Writes off the full remaining outstanding balance. Rejected for a terminal-status or already-zero-balance payable. "History preserved" — same as AR, nothing is deleted, only `status`/`outstandingBalance` change.

## Domain Events
`PayableWrittenOff`, `VendorSettlementCompleted`

---

# Endpoint Contract: POST /api/v1/accounts-payable/{payableId}/schedule-payment

*(Gap-fill.)*

## Permission
`finance.payable.update`

## Request Body
```json
{ "scheduledDate": "2027-03-10", "priority": "Priority" }
```
`priority`: config-driven (`AP_PAYMENT_PRIORITIES_JSON`) — Immediate, Scheduled, Priority, Urgent.

## Business Rules
Planning metadata only — does not execute or trigger a payment. Rejected for a terminal-status payable.

## Domain Events
`VendorPaymentScheduled`

---

# Enterprise Payment Engine — Finance Module Part 7

## Overview

"Everything that involves money goes through it." One centralized Payment Engine that AR, AP, and every future money-moving module (Booking, Visa, Travel, Payroll, Subscriptions, ...) call into as "specialized workflows." The payment record represents the *movement* of money; the calling module determines *why* it exists.

**Tenant-only, not branch-scoped** — same override as every other Finance part.

## A consolidation, not just a new module

Parts 5 and 6 each built their own minimal payment record (`PaymentModel`/`PaymentService` for customer payments, `VendorPaymentModel`/`VendorPaymentService` for vendor payments) because no Payments module existed yet at the time. Part 7's own spec explicitly names that exact split as the anti-pattern to avoid: *"Rather than having separate long-term payment logic for Customer Payments and Vendor Payments, keep them as specialized workflows built on top of the same Enterprise Payment Engine."*

This pass **consolidated** rather than adding a third, parallel system:

- `models/VendorPaymentModel.js`, `services/VendorPaymentService.js`, `controllers/VendorPaymentController.js`, and the `/vendor-payments` routes were **deleted**.
- `models/PaymentModel.js` was rewritten into the unified shape described below (still the same collection name, `payment`, that Part 5 already established).
- `AccountsReceivableService.allocatePayment` and `AccountsPayableService.allocatePayment` are **unchanged in their own request/response shape** — they still call `PaymentService.getPaymentById`/`consumeUnallocatedAmount`, which is exactly "specialized workflows on top of the same engine." The only internal change: the hard `payment.customerId`/`payment.vendorId` equality check each used to run became an *optional* check (enforced only when the payment actually carries that `partyType`/`partyId`), since a Payment Engine payment is an independent transaction and no longer guarantees a party at creation time — see below.
- `consumeUnallocatedAmount` now also appends to the payment's own `allocations[]` array (with `targetType`/`targetId`), so *every* consumption path — AR's, AP's, or the new generic one below — leaves a complete, bidirectional audit trail on the payment itself, not just on the receivable/payable side.

## Payments are independent transactions

The spec's own request example (`{"paymentType":"Customer","amount":25000,"currency":"PKR","paymentMethod":"Bank Transfer","reference":"INV-2027-0012"}`) has **no customer/vendor reference at all** — confirming the Overview's own framing: *"Payments are independent financial transactions that may later be allocated."* `partyType`/`partyId` exist on the model (informational, optional, resolved via Mongoose `refPath` to either `customer` or `vendor`) for convenience/reporting, but the real relationship is established through `allocations[]` when a payment is actually put to use.

## Gateway Abstraction

`services/gateways/BaseGatewayAdapter.js` mirrors this codebase's existing `services/gds/BaseGdsAdapter.js` pattern exactly (an interface every provider implements; `checkHealth()`; new providers plug in without touching call sites). Two adapters are real this pass:

- **Manual** (`ManualGatewayAdapter.js`) — Cash, Cheque, Bank Transfer. Genuinely real, not a stub: there is no external call to make for these methods, so recording the payment *is* the correct behavior.
- **Stripe** (`StripeGatewayAdapter.js`) — the real `stripe` npm package (installed this pass), real `PaymentIntent`/`refund` API calls, gated on `STRIPE_SECRET_KEY`. Every method throws a clear, honest error when unconfigured rather than fabricating a fake success — this module never simulates a gateway response, per this codebase's standing "never fake/mock/simulate an integration" rule.

**PayPal, Square, AuthorizeNet, Adyen, Razorpay, Custom** — configured as valid `gateway` values (so a tenant can express intent / the field is real), but no adapter is implemented; `PaymentService.createPayment` rejects them with a clear "not yet supported" error rather than silently falling back to Manual, which would misrepresent how the money actually moved. Adding one is a contained task: implement `BaseGatewayAdapter`'s four methods, register it in `services/gateways/index.js`.

## Fraud Detection — real, but explicitly not the spec's "AI advisory"

`PaymentService.computeFraudRiskScore` is a genuine, deterministic, unit-tested rule engine — Duplicate Payment (same tenant/amount/currency/method/reference within a configurable window), Velocity Check (payment count for the same reference within a window), Amount Threshold — each contributing real weight to a 0–100 `riskScore` stored on the payment. This is **not** the spec's "AI advisory" risk scoring; building genuine LLM-based fraud analysis is its own focused piece of work (prompt design, `AIToolRegistry` registration), consistent with every other "AI Insights" section deferred elsewhere in this Finance module (never faked with a heuristic dressed up as AI).

**Country Check and Blacklisted Customer are skipped entirely** — no country/IP field exists anywhere in this codebase to check against, and no blacklist flag exists on `Customer`/`Vendor`. Inventing either without being asked would be fabricating a data source, not implementing a real check.

## The generic Allocation Engine

`PaymentService.allocate` handles the "Supported Targets" list from the spec:

- **AccountsReceivable / AccountsPayable** — delegated entirely to `AccountsReceivableService.allocatePayment`/`AccountsPayableService.allocatePayment` (their own richer, fully-owned workflows: ledger journal, overpayment → credit, status lifecycle). Not reimplemented here.
- **Booking / Visa / Travel** — real modules already exist in this codebase (`BookingHeaderModel`, `VisaCaseModel`, `TravelPlanModel`), so the target's existence is genuinely validated (tenant-scoped lookup) before recording the allocation. This deliberately does **not** reach into those modules' own state (e.g. Booking's `paymentStatus`) — per this codebase's own layering rule, "cross-context communication goes through the event bus... not direct writes to another context's collections." `PaymentAllocated` is published; it's on those modules to subscribe if/when they want to react to it.
- **Invoice / Expense / Payroll / Subscription** — rejected with a clear "not yet supported — no {X} module exists in this codebase yet" error. No inert placeholder fields were added for these; an unvalidatable dangling reference would be worse than an honest rejection.

"Partial Allocation" (one payment funding multiple targets) and "Split Payments" (one target funded by multiple payment methods) both fall out of this design for free: the former from `unallocatedAmount` being drawn down across separate `allocate` calls to different targets; the latter from nothing preventing multiple separate `Payment` records (different methods) from each allocating to the same target.

## Scope boundaries (deliberate, not oversights)

- **Refund only covers the currently-*unallocated* portion of a payment.** Refunding an already-allocated portion would mean cascading the reversal into whatever it was allocated to (a receivable's ledger entries, a booking's status, ...) — a materially larger undertaking. Money already put to use should be reversed through *that* target's own mechanism (e.g. Journal reversal for AR/AP). `refund` throws a clear error pointing this out if the requested amount exceeds `unallocatedAmount`.
- **Settlement** (bank-side confirmation that funds actually cleared) has no dedicated endpoint or async job — no real bank/settlement integration exists to drive it. `Captured` is the practical terminal state for gateway-processed money in this pass; `Settled`/`Completed` remain valid configured statuses for a future settlement reconciliation process to set.
- **Chargeback** requires real gateway webhook infrastructure (signature verification, async dispute processing) — genuinely out of scope this pass. The status value exists in the configured lifecycle; nothing sets it yet.
- **Installments** (Monthly/Weekly/Quarterly/Custom Schedule with automatic reminders) — needs its own recurring-schedule engine and no endpoint was contracted; deferred, same reasoning as Recurring Journals (Part 3).

---

# Endpoint Contract: POST /api/v1/payments

## Permission
`finance.payment.create`

## Request Example
```json
{
  "paymentType": "Customer",
  "amount": 25000,
  "currency": "PKR",
  "paymentMethod": "Bank Transfer",
  "reference": "INV-2027-0012"
}
```
`partyType`/`partyId`, `gateway`, and `gatewayPaymentMethodId` (a pre-tokenized Stripe payment method, when paying via Stripe) are optional additions beyond the spec's own example.

## Business Workflow
```
Validate Request
      |
      v
Fraud Check (rule-based — Duplicate/Velocity/Amount Threshold)
      |
      v
Resolve Gateway (Manual for Cash/Cheque/Bank Transfer; else the tenant's configured default)
      |
      v
Gateway Processing (authorize -> capture, real adapter calls)
      |
      v
Payment Created
      |
      v
Timeline + Audit
      |
      v
Publish PaymentCreated (+ PaymentAuthorized/PaymentCaptured, or PaymentFailed)
```
A gateway failure doesn't throw an HTTP error — it returns the payment with `status: "Failed"` and `failureReason` populated (HTTP 402), since the record of the failed *attempt* is itself real, auditable data ("Failure reasons stored").

## Domain Events
`PaymentCreated`, `PaymentAuthorized`, `PaymentCaptured`, `PaymentFailed`

---

# Endpoint Contract: GET /api/v1/payments

## Permission
`finance.payment.read` (or `finance.read`, or `admin`)

## Query Parameters
`status`, `paymentType`, `currency`, `paymentMethod`, `gateway`, `partyId`, `dateFrom`/`dateTo`, `page`, `pageSize`, `sort` (`branch` dropped)

## Response Includes
Payment ID, Payment Number, Payment Type, Amount, Currency, Gateway, Status, Reference, Created Date — plus `unallocatedAmount`, `allocations[]`, `fraudCheck`, `gatewayDetails`.

## Business Rules
Filtering, pagination, sorting, tenant isolation.

---

# Endpoint Contract: POST /api/v1/payments/{paymentId}/allocate

## Permission
`finance.payment.allocate`

## Request Example
```json
{ "targetType": "Booking", "targetId": "665f1a2b3c4d5e6f7a8b9c0d", "amount": 40000 }
```

## Supported Targets
`AccountsReceivable`, `AccountsPayable` (delegated to their own services), `Booking`, `Visa`, `Travel` (existence-validated directly). `Invoice`, `Expense`, `Payroll`, `Subscription` are configured values that currently reject with a clear "not yet supported" error — see "The generic Allocation Engine" above.

## Business Rules
Only `Captured`/`Allocated` payments accept a new allocation. Amount must not exceed the payment's current `unallocatedAmount`. Multiple allocations across different targets are supported ("Partial Allocation").

## Domain Events
`PaymentAllocated`

---

# Endpoint Contract: POST /api/v1/payments/{paymentId}/void

*(Gap-fill — "Payment Reversal: Void" named in the spec with no contracted endpoint.)*

## Permission
`finance.payment.void`

## Business Rules
Only before any funds were put to use (`Initiated`/`Pending`/`Authorized`/`Captured` — never once allocated). Calls the gateway adapter's `void()` for gateway-processed payments.

## Domain Events
`PaymentReversed`

---

# Endpoint Contract: POST /api/v1/payments/{paymentId}/refund

*(Gap-fill — "Payment Reversal: Refund" named in the spec with no contracted endpoint.)*

## Permission
`finance.payment.refund`

## Business Rules
Limited to the currently-unallocated portion (see Scope Boundaries above). Calls the gateway adapter's `refund()` for gateway-processed payments.

## Domain Events
`PaymentRefunded`

---

# Domain Events (Part 7 Summary)

`PaymentCreated`, `PaymentAuthorized`, `PaymentCaptured`, `PaymentAllocated`, `PaymentFailed`, `PaymentReversed`, `PaymentRefunded`.

Not yet implemented (require deferred features above to have meaning): `PaymentSettled`, `PaymentChargeback`.

---

# Enterprise Receipts — Finance Module Part 8

## Overview

"Payment != Receipt. A payment is a financial transaction. A receipt is an official acknowledgment that the payment has been received." A receipt links back to exactly one Payment (Part 7) but is its own immutable document — corrections happen via reissue or cancellation, never by editing an existing receipt's core facts.

**Tenant-only, not branch-scoped** — same override as every other Finance part; receipt numbering (`RCT-{year}-{seq}`) has no branch segment despite the spec's own `RCT-KHI-2027-000567` example including one.

## What's genuinely real vs. deferred this pass

Every piece of infrastructure this module touches was checked against what's actually installed/wired in this codebase before deciding real-vs-deferred — nothing here fakes an integration it doesn't have:

- **PDF generation — real.** `pdfkit` (installed this pass) generates an actual PDF byte stream (verified: magic bytes `%PDF`), with a template-aware header (`ReceiptPdfService.js`'s `TEMPLATE_TITLES` map) and the QR code embedded as an image.
- **QR code generation — real.** `qrcode` (installed this pass) generates an actual PNG (verified: PNG magic bytes) encoding the public verification URL. Needs no credentials — always available.
- **Email delivery — real.** A new shared `EmailDeliveryAdapter` using the exact same SMTP config (`utils/authConfig.js`) and real `nodemailer` transport pattern `controllers/Auth.js` already uses for account emails — built as its own instance rather than touching Auth.js's already-working transporter, so this module carries zero regression risk to the existing auth email flow.
- **WhatsApp/SMS delivery — real.** The real `twilio` npm package (installed this pass), actual Messages API calls, gated on `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_FROM`/`TWILIO_SMS_FROM`. Every adapter method returns `"NotConfigured"` honestly when credentials are absent — never a fabricated "Sent."
- **Webhook delivery — real.** A genuine HTTP POST (Node's built-in `fetch`) to a caller-supplied `webhookUrl` on the request. This codebase has no tenant-level default webhook URL to fall back to, so omitting it is recorded as this channel not being set up for that request, not silently skipped.
- **File storage — real, reusing the existing abstraction.** `utils/receiptPdfStorage.js` writes the generated PDF buffer directly to disk for the `local` backend (genuinely new — nothing in this codebase previously needed to serve a server-*generated* file, only user-*uploaded* ones), and for `cloudinary`/`s3` backends writes to a temp file and hands off to `services/FileUploadService.js`'s existing `uploadToCloud` — reusing the real cloud-upload logic rather than reimplementing it.
- **PKI digital signatures — deferred, not faked.** "PKI Signature, Organization Seal, Certificate-Based Signing" needs a real certificate authority / organizational certificate this environment doesn't have. Signing with an arbitrary self-generated key would provide no actual trust value — that's theater, not a real signature — so `digitalSignature.isSigned` stays `false` and nothing pretends otherwise.
- **Print, Customer Portal, Mobile App delivery — deferred.** Print needs no delivery action (the PDF itself is the printable artifact — there's no printer integration to call). Customer Portal and Mobile App have no such surface anywhere in this codebase to deliver to. Requesting either is honestly recorded as `"NotConfigured"` in `deliveryHistory`, never silently dropped.
- **Settlement/"ReceiptDelivered" honesty.** A receipt only advances to `Delivered` once at least one channel's adapter genuinely reports `Sent` (`resolveStatusAfterDelivery`, unit-tested) — never assumed just because delivery was attempted.

## Two deliberately public endpoints

`GET /api/v1/receipts/verify/:token` and `GET /api/v1/receipts/download/:token` have **no** `authenticateAccessToken` — registered before that middleware is applied in `routes/FinanceRoutes.js` (same principle `routes/VisaRoutes.js` uses for its one public route, there via per-route auth instead of a blanket gate). This is an explicit spec requirement, not an oversight: *"QR Code -> Public Verification API -> Receipt Valid -> Payment Verified"* — whoever is shown a receipt (a customer, a third party, an auditor) needs to verify it without an ERP login, and a customer who received a receipt link by email/WhatsApp has no login to present in the first place.

Access control is the token itself — 24 cryptographically random bytes (`ReceiptQrService.generateVerificationToken`), effectively unguessable — rather than authentication, the same "capability URL" pattern used for things like shipment tracking or e-ticket verification. Because there's no auth gate, the verification response is deliberately minimal: receipt number, amount, currency, issue date, status — **no customer name, no internal ids beyond the receipt number itself**.

## Endpoint contract gaps filled

Only `POST /receipts` (create), `GET /receipts` (list), `GET /receipts/{id}`, and `POST /receipts/{id}/reissue` were contracted. The spec's own Receipt Lifecycle and Domain Events name states/events with nothing to reach them:

- `POST /api/v1/receipts/{receiptId}/cancel` — reaches `Cancelled` / fires `ReceiptCancelled`. Reason required, matching "Receipt Cancellation... Reason required. History preserved." (nothing is deleted — only `status`/`cancelledBy`/`cancelledAt`/`cancellationReason` change).
- `POST /api/v1/receipts/{receiptId}/redeliver` — "Delivery Channels... Supports delivery retry" named a capability with no endpoint. Every attempt (original + every retry) is appended to `deliveryHistory`, never overwritten — the full delivery attempt history stays intact.
- `Voided` (Lifecycle) has no corresponding domain event anywhere in the spec's own list — left genuinely unreachable rather than merged into `Cancel` by guesswork; `Cancel` covers the "administrative correction with a reason" use case the spec actually describes.

## One payment, one receipt (by default)

"Receipt Not Already Generated (Configurable)" — `createReceipt` rejects a second receipt for the same payment unless `RECEIPT_ALLOW_MULTIPLE_PER_PAYMENT=true`. "A single payment may generate one or multiple receipts, depending on business rules" is satisfied by this being a real, tenant-configurable toggle, not hardcoded either way.

## Deferred (named in the spec, not built this pass)

- **Digital Signatures / PKI** — see above.
- **Taxes / Discounts** on the receipt response — structurally present (`taxes[]`, `discounts[]`) but empty; the Tax Engine and Discount Engine are their own still-unbuilt future Parts, same placeholder pattern as AR/AP's `creditNoteIds`.
- **Batch Receipt Generation** — no endpoint was contracted for generating many receipts in one call; `createReceipt` handles one payment at a time.
- **Installment Receipts** — depends on the still-deferred Installments feature from Part 7.

---

# Endpoint Contract: POST /api/v1/receipts

## Permission
`finance.receipt.create`

## Request Example
```json
{
  "paymentId": "665f1a2b3c4d5e6f7a8b9c0d",
  "template": "Default",
  "deliveryMethods": ["Email", "WhatsApp"]
}
```
`partyType`/`partyId` (override the payment's own party) and `webhookUrl` (required only if `"Webhook"` is a requested delivery method) are optional additions beyond the spec's own example.

## Business Workflow
```
Validate Payment (must exist, tenant-scoped)
      |
      v
Validate Payment Verified (status in Captured/Allocated/Settled/Completed)
      |
      v
Validate Not Already Generated (unless RECEIPT_ALLOW_MULTIPLE_PER_PAYMENT)
      |
      v
Resolve Party (override, or the payment's own partyType/partyId)
      |
      v
Assign Receipt Number
      |
      v
Generate QR Code (real, encodes the public verification URL)
      |
      v
Generate PDF (real, template-aware, QR embedded)
      |
      v
Attempt Delivery per requested method (real adapters; failures recorded, not fatal)
      |
      v
Timeline + Audit
      |
      v
Publish ReceiptGenerated (+ ReceiptIssued / ReceiptDelivered as applicable)
```

## Validation Rules
Payment Exists, Payment Verified, Receipt Not Already Generated (configurable), Tenant Match.

## Domain Events
`ReceiptGenerated`, `ReceiptIssued`, `ReceiptDelivered`

---

# Endpoint Contract: GET /api/v1/receipts

## Permission
`finance.receipt.read` (or `finance.read`, or `admin`)

## Query Parameters
`receiptNumber`, `paymentId`, `customerId` (maps to `partyType: "customer"` + `partyId`), `status`, `dateFrom`/`dateTo`, `page`, `pageSize`, `sort` (`branch` dropped)

## Response Includes
Receipt ID, Receipt Number, Payment Number, Amount, Currency, Issue Date, Status, Delivery Status (`deliveryHistory[]`), Created Date.

## Business Rules
Filtering, pagination, sorting, tenant isolation.

---

# Endpoint Contract: GET /api/v1/receipts/{receiptId}

## Permission
`finance.receipt.read` (or `finance.read`, or `admin`)

## Response Includes
Receipt Information, Payment Details, Allocations (`allocationsSnapshot` — frozen at generation time, not live), Taxes/Discounts (empty until those modules ship), Delivery History, Timeline, Audit Summary, PDF URL, QR Verification URL.

---

# Endpoint Contract: POST /api/v1/receipts/{receiptId}/reissue

## Permission
`finance.receipt.reissue`

## Business Workflow
```
Validate Permission
      |
      v
Generate New Copy (new receiptNumber, new QR token, new PDF)
      |
      v
Link Original Receipt (reissueOf / reissuedBy)
      |
      v
(Optional) Attempt Delivery, if deliveryMethods supplied
      |
      v
Timeline + Audit
      |
      v
Publish ReceiptReissued
```
"Original receipt preserved" — the original's own document is never mutated beyond `status: "Reissued"` and the `reissuedBy` link.

## Domain Events
`ReceiptReissued`

---

# Endpoint Contract: POST /api/v1/receipts/{receiptId}/cancel

*(Gap-fill — see "Endpoint contract gaps filled" above.)*

## Permission
`finance.receipt.cancel`

## Request Body
```json
{ "reason": "Duplicate receipt issued in error" }
```

## Domain Events
`ReceiptCancelled`

---

# Endpoint Contract: POST /api/v1/receipts/{receiptId}/redeliver

*(Gap-fill.)*

## Permission
`finance.receipt.create`

## Request Body
```json
{ "deliveryMethods": ["Email"] }
```

## Domain Events
`ReceiptDelivered` (only if at least one retried channel confirms `Sent`)

---

# Endpoint Contract: GET /api/v1/receipts/verify/{token}

*(Public — see "Two deliberately public endpoints" above.)*

## Response
```json
{ "valid": true, "receiptNumber": "RCT-2027-000567", "amount": 25000, "currency": "PKR", "issueDate": "2027-02-01", "status": "Viewed", "paymentVerified": true }
```

## Domain Events
`ReceiptViewed`

---

# Endpoint Contract: GET /api/v1/receipts/download/{token}

*(Public — same reasoning as verify above.)*

## Business Rules
Redirects (HTTP 302) to the receipt's real stored PDF URL.

## Domain Events
`ReceiptDownloaded`

---

# Domain Events (Part 8 Summary)

`ReceiptGenerated`, `ReceiptIssued`, `ReceiptDelivered`, `ReceiptViewed`, `ReceiptDownloaded`, `ReceiptCancelled`, `ReceiptReissued`, `ReceiptVerified`\*.

\* `ReceiptVerified` — the spec lists this alongside `ReceiptViewed`, but a QR scan already fires `ReceiptViewed` for the same action (verifying *is* viewing here); treated as the same signal rather than firing two near-duplicate events for one action.

---

# Enterprise Invoices — Finance Module Part 9

## Overview

"An invoice is much more than a PDF. It is a financial contract." An Invoice is version-controlled, generates its own PDF, and — once formally issued — becomes the trigger for a real Accounts Receivable record. This is the module that finally closes a loop opened four parts ago.

**Tenant-only, not branch-scoped** — same override as every other Finance part; invoice numbering (`INV-{year}-{seq}`) has no branch segment despite the spec's own `INV-KHI-2027-000874` example including one.

## Closing the InvoiceCreated loop

Part 5 built `AccountsReceivableService.initEventListeners()` — a listener for an `InvoiceCreated` event that nothing published, "dormant until Part 7 ships and starts publishing it... zero code changes needed here when it does." That listener's code was never touched this pass. `InvoiceService.issueInvoice` now publishes `InvoiceCreated` with exactly the payload shape AR's listener has always expected (`tenantId`, `customerId`, `invoiceNumber`, `amount`, `issueDate`, `dueDate`, `currency`, `invoiceId`, `revenueAccountCode`, `performedBy` — verified against AR's actual subscriber code before writing this, not assumed from memory). `server.js` now calls `InvoiceService.initEventListeners()` alongside AR's own, mirroring its exact wiring pattern.

This was checked as carefully as possible without a live end-to-end DB test in the permanent suite: AR's actual subscriber code (`AccountsReceivableService.initEventListeners`) was read field-by-field before writing `issueInvoice`'s `publishEvent` call, not recalled from memory, and every required field (`tenantId`, `customerId`, `invoiceNumber`, `amount`) plus every optional one AR's handler reads is present. A live-database integration test exercising this for real (create customer → create/approve/issue invoice → assert a real `AccountsReceivableModel` appears) was written and attempted, but hit an unresolved hang against this environment's MongoDB connection when run in isolation — it was removed rather than leave a test that could block `node --test` from ever completing again, so this integration is verified by contract-matching and the full pure-logic suite, not by a passing live DB assertion.

## Why "Generate AR" happens at Issue, not at Draft creation

The spec's own `POST /invoices` Business Workflow lists "...Approval Workflow → Generate Invoice Number → Generate PDF → Generate AR → Publish InvoiceCreated → Return Success" as if every step happens synchronously inside the create call. But the Invoice Lifecycle diagram shows `Draft → Pending Approval → Approved → Issued` as real, separate gated states, and `PATCH /invoices/{id}` is explicitly scoped to "Draft invoices only" — meaning Draft has to be a genuinely different, still-editable state from whatever comes after.

This is the same tension already resolved identically for Journal (Part 3) and Accounts Payable (Part 6): creation starts at the earliest real state; separate `approve`/`issue` actions perform the later steps. Applied here: `POST /invoices` creates a `Draft` (with its invoice number and a real preview PDF already generated — numbering happens at creation everywhere else in this module too), and **AR generation — along with firing `InvoiceCreated` — happens at the `issue` gap-fill endpoint**, not at Draft creation. This also matches real-world accounting practice: you don't want to dun a customer over a document nobody approved or sent yet.

## Minimal, real tax/discount calculation — not the future Tax/Discount Engine

Per-line tax (`taxCode` → configured rate) and discount (`Percentage`/`Flat`) calculation is real and unit-tested (`computeLineTotals`/`computeInvoiceTotals` — verified against the spec's own worked example: 2 × 250 with 15% VAT = 575). An unrecognized `taxCode` is a genuine validation error, never silently treated as 0%. This is deliberately **not** the dedicated Tax Engine / Discount Engine the roadmap still lists as separate future Parts — no jurisdiction rules, compound taxes, exemption certificates, coupon codes, or promotional campaigns exist here. When those Parts ship, they will likely supersede this minimal calculation, not sit alongside it as a second system.

## Endpoint contract gaps filled

Only `POST /invoices`, `GET /invoices`, `GET /invoices/{id}`, and `PATCH /invoices/{id}` were contracted. The spec's own Lifecycle and Domain Events name states/events with nothing to reach them:

- `POST /api/v1/invoices/{invoiceId}/approve` — Draft/Pending Approval → Approved. Single configurable gate (`INVOICE_APPROVAL_REQUIRED`), same reasoning as Journal's and AP's identical approval-policy ambiguity (no concrete multi-tier thresholds were given).
- `POST /api/v1/invoices/{invoiceId}/issue` — Approved → Issued; fires `InvoiceCreated` + `InvoiceIssued`; regenerates the final PDF. See above.
- `POST /api/v1/invoices/{invoiceId}/cancel` — Draft/Pending Approval/Approved only (before anything was ever billed).
- `POST /api/v1/invoices/{invoiceId}/void` — Issued only, and **only if the linked receivable has zero payments applied**. Once money has actually moved, voiding the invoice would erase billed history that a payment already relies on — use the receivable's own write-off/reversal mechanisms instead.
- `POST /api/v1/invoices/{invoiceId}/close` — Paid → Closed. Manual, not automatic: "Closed" reads as a deliberate month-end/reconciliation action in real accounting practice, not something that should happen the instant a balance hits zero.
- `Disputed` (Lifecycle) has no corresponding domain event anywhere in the spec's own list — left genuinely unreachable, same treatment AR's identical `Disputed` state got in Part 5.

## Outstanding Balance is never stored — always live

`outstandingBalance` is deliberately not a field on `InvoiceModel`. `InvoiceService._withLiveBalance` looks up the linked `AccountsReceivableModel` (joined by the shared `invoiceNumber`, the same natural-key join AR itself already uses) on every list/get call and reads its real, current `outstandingBalance`. Same "never trust a cached number when the source of truth is one query away" discipline already applied to the Ledger (Part 4) — a stored copy here could drift the moment a payment is allocated on the AR side, and nothing would ever correct it.

## Reusing AR's existing overdue scheduler — not a second one

`InvoiceOverdue` does not get its own scheduler. `InvoiceService.initEventListeners()` subscribes to AR's already-real `ReceivableOverdue` event (fired by `services/receivableOverdueScheduler.js`, Part 5) and mirrors the status onto the linked invoice. Building a second, duplicate overdue-detection cron job for the same underlying fact (a receivable's due date has passed) would be exactly the kind of duplicated logic Part 1's own architecture review warns against.

## Payment-status sync (Partially Paid / Paid)

The same event-listener pattern handles `PaymentAllocated` and `ReceivablePaid` from AR — when either fires for a receivable whose `invoiceNumber` matches an invoice, the invoice's own `status` is updated (`Issued`/`Partially Paid` → `Partially Paid` or `Paid`, based on the receivable's real outstanding balance) and `arReceivableId` is cached on the invoice the first time it's resolved, for a faster join on subsequent reads.

## Deferred (named in the spec, not built this pass)

- **Recurring Invoices** (`RecurringInvoiceGenerated`) — needs a scheduler and a recurrence-rule model, same reasoning as Recurring Journals (Part 3): the `invoiceType: "Recurring"` value exists so a future scheduler has something real to tag.
- **AI anomaly detection** — same standing reasoning as every other "AI Insights" section deferred this session: a real LLM integration is its own focused piece of work, never a heuristic dressed up as one.
- **Country Rules** in numbering — no concrete jurisdiction-specific numbering rules were given; numbering is `{prefix}-{year}-{sequence}` like every other document type in this module.
- **Consolidated/Installment invoice generation logic** — the `invoiceType` values exist, but no special multi-source-aggregation or schedule-splitting behavior was specified beyond standard single-invoice creation.

---

# Endpoint Contract: POST /api/v1/invoices

## Permission
`finance.invoice.create`

## Request Example
```json
{
  "customerId": "665f1a2b3c4d5e6f7a8b9c0d",
  "currency": "USD",
  "invoiceType": "Commercial",
  "dueDate": "2027-03-15",
  "items": [
    { "description": "USA Tourist Visa", "quantity": 2, "unitPrice": 250, "taxCode": "VAT" }
  ]
}
```

## Business Workflow
```
Validate Customer
      |
      v
Validate Financial Period Open (issueDate)
      |
      v
Validate Items + Calculate Pricing/Taxes/Discounts (per line, then invoice totals)
      |
      v
Generate Invoice Number
      |
      v
Generate PDF (preview — regenerated again at Issue)
      |
      v
Timeline + Audit
      |
      v
Return Success (status: Draft)
```
"Generate AR" and "Publish InvoiceCreated" happen at `issue`, not here — see "Why Generate AR happens at Issue" above.

## Validation Rules
Customer Exists, Items Valid, Currency Supported, Financial Period Open, Tenant Match.

---

# Endpoint Contract: GET /api/v1/invoices

## Permission
`finance.invoice.read` (or `finance.read`, or `admin`)

## Query Parameters
`customerId`, `invoiceNumber`, `status`, `invoiceType`, `currency`, `dateFrom`/`dateTo`, `page`, `pageSize`, `sort` (`branch` dropped)

## Response Includes
Invoice ID, Invoice Number, Customer, Invoice Type, Issue Date, Due Date, Subtotal, Tax, Discount, Grand Total, Outstanding Balance (live-joined — see above), Status, Currency, Created Date.

---

# Endpoint Contract: GET /api/v1/invoices/{invoiceId}

## Permission
`finance.invoice.read` (or `finance.read`, or `admin`)

## Response Includes
Invoice Header, Invoice Lines, Taxes, Discounts, Payment History (the linked receivable's `allocations[]`), Receipt History (real join: every Receipt whose `paymentId` appears in those allocations), Credit Notes (`creditNoteIds`, empty until that module ships), Timeline, Audit Summary, PDF URL.

---

# Endpoint Contract: PATCH /api/v1/invoices/{invoiceId}

## Permission
`finance.invoice.update`

## Editable Fields
Items, Due Date, Discounts (part of Items), Notes, Attachments. Draft invoices only.

## Business Rules
"Invoice Versioning... Historical versions preserved" — the full pre-edit document is snapshotted into `versionHistory[]` before any change is applied, and `version` increments. The PDF is regenerated to reflect the new totals.

## Domain Events
`InvoiceUpdated`

---

# Endpoint Contract: POST /api/v1/invoices/{invoiceId}/approve

*(Gap-fill.)*

## Permission
`finance.invoice.approve`

## Domain Events
`InvoiceApproved`

---

# Endpoint Contract: POST /api/v1/invoices/{invoiceId}/issue

*(Gap-fill — see "Why Generate AR happens at Issue" above.)*

## Permission
`finance.invoice.issue`

## Domain Events
`InvoiceCreated` (triggers AR generation), `InvoiceIssued`

---

# Endpoint Contract: POST /api/v1/invoices/{invoiceId}/cancel

*(Gap-fill.)*

## Permission
`finance.invoice.cancel`

## Domain Events
`InvoiceCancelled`

---

# Endpoint Contract: POST /api/v1/invoices/{invoiceId}/void

*(Gap-fill.)*

## Permission
`finance.invoice.cancel`

## Business Rules
Issued only, and only when the linked receivable has zero payments applied.

## Domain Events
`InvoiceVoided`

---

# Endpoint Contract: POST /api/v1/invoices/{invoiceId}/close

*(Gap-fill.)*

## Permission
`finance.invoice.update`

## Business Rules
Paid → Closed only. Manual, not automatic.

## Domain Events
`InvoiceClosed`

---

# Domain Events (Part 9 Summary)

`InvoiceUpdated`, `InvoiceApproved`, `InvoiceCreated`, `InvoiceIssued`, `InvoiceCancelled`, `InvoiceVoided`, `InvoicePaid`, `InvoiceOverdue`, `InvoiceClosed`.

Not yet implemented (require deferred features above to have meaning): `RecurringInvoiceGenerated`.

---

# Part 10 — Enterprise Credit Note APIs

## Overview
A credit note always originates against an already-issued invoice: `Invoice Created -> Customer Returns Item -> Credit Note Issued -> Accounts Receivable Adjusted -> Customer Credit Wallet Updated OR Refund Issued`. This part reuses three placeholders built specifically for it in earlier parts, rather than inventing parallel structures:
- `InvoiceModel.creditNoteIds[]` (Part 9) and `AccountsReceivableModel.creditNoteIds[]`/`adjustments[].type` already documenting `"CreditNoteApplied"` (Part 5) — both now actually populated.
- `CustomerCreditModel.source` already listing `"CreditNote"` as a valid value (Part 5) — now actually produced.

## Lifecycle interpretation
`Draft -> Pending Approval -> Approved -> Issued -> Allocated -> Closed`, with `Cancelled` (from any pre-Issued state) and `Voided` (from Issued only, pre-allocation) as side exits. Same gated-states reasoning already applied identically to Journal/AP/Invoice (a "Business Workflow" narrative listing many steps in one paragraph is not the same as one atomic HTTP call — the Lifecycle diagram's separate states are the real contract).

**Unlike AP's Approved -> Open collapse, Issued and Allocated are deliberately kept as two separate actions/states here.** Issued finalizes the document (PDF) with no financial effect yet; Allocated is the step that actually posts to Accounts Receivable and the General Ledger. This mirrors real-world batch-posting practice (a credit memo can be handed to a customer immediately while its GL/AR posting happens moments later) and, practically, gives a genuine void-before-consequence window — an Issued-but-not-yet-Allocated credit note can be voided cleanly, exactly like Invoice's own "void only before payments" rule.

**`CreditNoteCreated` fires at real creation (Draft), not at Issue.** This is the opposite of Invoice's own deferral of `InvoiceCreated` to its Issue step — that deferral existed *only* because AR's Part-5 listener treats `InvoiceCreated` as "a real billed invoice now exists." No such collision exists here: nothing subscribes to `CreditNoteCreated` expecting AR to already be adjusted (that is `CreditNoteAllocated`'s job, invoked as a direct service call, not an event). So `CreditNoteCreated` follows this codebase's default convention for every other `XCreated` event (`ReceivableCreated`, `PayableCreated`, etc.) and fires where it actually happens.

**No separate `reject()` endpoint.** Journal's spec explicitly names `JournalRejected` as a domain event, which is why Journal has a dedicated reject action. This spec's own Domain Events list has no `CreditNoteRejected` — `cancel()` already covers "this credit note doesn't proceed" for every pre-issue state, so a second, unnamed action wasn't built.

## Tax Adjustments — real recalculation, not caller-supplied
The request body only supplies `{invoiceLineId, quantity, amount}` — the credit amount before tax — matching the spec's own worked example. Tax is then recalculated for real against the **original invoice line's own `taxCode`/rate** (`CreditNoteService.computeCreditLineTotals`, reusing `InvoiceService.resolveTaxRate`), never guessed or left to the caller. An unrecognized taxCode on the original line is a hard error, same discipline as Invoice.

## Validate Remaining Credit
An invoice's total creditable capacity is its own `grandTotal` minus every credit note already **issued** against it (`Issued`/`Allocated`/`Closed` count; `Draft`/`Pending Approval`/`Approved`/`Cancelled`/`Voided` don't, so concurrent drafts don't needlessly block each other). Checked at creation, and **re-checked at issue time** — same "validate now, re-validate at the point it matters" discipline as Journal/Invoice's period-open re-checks (another credit note against the same invoice may have been issued in between).

## Accounts Receivable integration — `AccountsReceivableService.applyCreditNote`
`allocateCreditNote` calls a new AR method that reduces the receivable's outstanding balance by the credit note's `grandTotal`, reusing the **exact same overpayment-split math** as `allocatePayment` (`computeOverpaymentSplit`/`resolveStatusAfterPayment` from `utils/paymentAllocationUtils.js`): a credit note is conceptually "negative money owed," so any portion beyond what's still outstanding (because the invoice was already partially/fully paid) becomes real `CustomerCredit` (`source: "CreditNote"`) instead of driving the balance negative — identical reasoning to a cash overpayment, zero new math invented.

## Refund Eligibility — honest scope boundary
"Refund Engine -> Approved Refund OR Customer Credit Wallet" is a real decision point, but there is **no mechanism anywhere in this codebase to auto-execute a bank refund from a credit note** — `PaymentService.refund` refunds a *specific* payment's unallocated portion, and a credit note has no single originating payment to refund from (money may have come from multiple payments, or none yet, or the invoice may still be unpaid). Rather than fabricate an automatic payout:
- The excess-beyond-outstanding-balance portion **always** becomes real, immediately-usable `CustomerCredit` regardless of `disposition`.
- `disposition: "Refund"` additionally fires `RefundRequested` — a genuine, real signal for finance-ops or a future dedicated Refund Management module (already on this doc's own roadmap) to actually move money.

## Ledger posting
`allocateCreditNote` posts Debit Revenue (`defaultRevenueAccountCode`) / Credit AR Control (`arControlAccountCode`) for the credit note's `grandTotal` — the mirror-opposite of Invoice's own AR-creation journal, since crediting a customer literally reverses part of it. Same "skip posting until both codes are configured" fallback as every other optional account code in this module.

## Customer Credit Wallet auto-apply — closing a Part 5 deferral
`AccountsReceivableModel.createReceivable` now auto-applies any existing Active `CustomerCredit` for that customer against a brand-new receivable, via a new `CustomerCreditService.consumeAvailableCredits` method that mirrors `VendorCreditService.consumeAvailableCredits` (used by AP since Part 6) exactly. This was explicitly deferred in Part 5 ("Applying existing credit to a receivable has no endpoint yet") for lack of a concrete event/endpoint to build against; Part 10 names one (`CreditApplied`), so it's completed now rather than left dangling further.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/credit-notes

## Permission
`finance.creditnote.create`

## Request Example
```json
{
  "invoiceId": "665f1c2e8b3a4d0012a4e111",
  "reason": "Service Cancellation",
  "items": [
    { "invoiceLineId": "665f1c2e8b3a4d0012a4e222", "quantity": 1, "amount": 250 }
  ],
  "disposition": "CustomerCredit"
}
```

## Business Workflow
Validate Invoice (must be Issued/Partially Paid/Paid/Overdue/etc., not Draft/Cancelled/Voided) -> Validate Remaining Credit -> Calculate Taxes (per-line, from the original invoice line) -> Generate Credit Number -> Generate PDF -> Timeline -> Audit -> Publish `CreditNoteCreated`.

## Validation Rules
Invoice exists and was actually issued; `reason` is one of the configured `creditNoteReasons`; every `invoiceLineId` exists on that invoice; requested `grandTotal` does not exceed the invoice's remaining creditable amount; financial period open.

## Domain Events
`CreditNoteCreated`

---

# Endpoint Contract: GET /api/v1/credit-notes

## Permission
`finance.creditnote.read`

Filters: `invoiceId`, `invoiceNumber`, `customerId`, `status`, `currency`, pagination/sort.

---

# Endpoint Contract: GET /api/v1/credit-notes/{creditNoteId}

## Permission
`finance.creditnote.read`

Includes the audit-log summary, same pattern as every other Finance resource's detail endpoint.

---

# Endpoint Contract: POST /api/v1/credit-notes/{creditNoteId}/approve

*(Gap-fill — same single configurable approval gate as Journal/AP/Invoice.)*

## Permission
`finance.creditnote.approve`

## Domain Events
`CreditNoteApproved`

---

# Endpoint Contract: POST /api/v1/credit-notes/{creditNoteId}/issue

*(Gap-fill — Approved -> Issued has no other trigger given.)*

## Permission
`finance.creditnote.issue`

## Business Rules
Re-validates the remaining creditable amount and the financial period before finalizing the PDF.

## Domain Events
`CreditNoteIssued`

---

# Endpoint Contract: POST /api/v1/credit-notes/{creditNoteId}/allocate

*(Gap-fill — `CreditNoteAllocated` is a named domain event with no endpoint contracted for it. This is where "Update Accounts Receivable -> Generate Journal -> Update Ledger" from the spec's own Business Workflow actually happens — see "Accounts Receivable integration" above for why it's a separate step from Issue.)*

## Permission
`finance.creditnote.issue`

## Domain Events
`CreditNoteAllocated` (fired both by this service and, carrying `receivableId`, by `AccountsReceivableService.applyCreditNote`), `RefundRequested` (only when `disposition === "Refund"`), `CustomerCreditCreated` (when the credit note produces an excess credit), `ReceivableSettled` (when this fully settles the linked receivable).

---

# Endpoint Contract: POST /api/v1/credit-notes/{creditNoteId}/cancel

*(Gap-fill. Covers Draft/Pending Approval/Approved — see "No separate reject() endpoint" above.)*

## Permission
`finance.creditnote.cancel`

## Domain Events
`CreditNoteCancelled`

---

# Endpoint Contract: POST /api/v1/credit-notes/{creditNoteId}/void

*(Gap-fill. Issued only, pre-allocation — once AR has been touched, use its own mechanisms instead, same rule as Invoice's void.)*

## Permission
`finance.creditnote.cancel`

## Domain Events
`CreditNoteVoided`

---

# Endpoint Contract: POST /api/v1/credit-notes/{creditNoteId}/close

*(Gap-fill. Allocated -> Closed only, manual.)*

## Permission
`finance.creditnote.issue`

## Domain Events
`CreditNoteClosed`

---

# Domain Events (Part 10 Summary)

`CreditNoteCreated`, `CreditNoteApproved`, `CreditNoteIssued`, `CreditNoteAllocated`, `CreditApplied` (fired by AR at receivable-creation time when existing customer credit auto-applies — not specific to any one credit note), `CustomerCreditCreated`, `RefundRequested`, `CreditNoteCancelled`, `CreditNoteVoided`, `CreditNoteClosed` (fired for audit-trail symmetry with every other module's terminal action, even though not individually named in the source spec's event list).

## Deferred / not built this pass
- **Inventory Integration** — the spec mentions inventory adjustment on a returned-item credit note; this codebase has no Inventory/Stock module to integrate with, so it's honestly skipped rather than faked.
- **Automatic bank refund execution** — see "Refund Eligibility" above; `RefundRequested` is the real, honest boundary of this module's responsibility.
- **Per-line remaining-quantity tracking across multiple partial credit notes** — "Validate Remaining Credit" is enforced at the invoice-total level (sum of all issued credit notes' `grandTotal` vs. the invoice's own `grandTotal`), not per-line remaining-quantity bookkeeping — the spec's own examples describe invoice-total-level partial/full credits, not line-level quantity ledgers.

---

# Part 11 — Enterprise Debit Note APIs

## Overview
The mirror-opposite of Credit Notes: `Invoice = 10,000, Debit Note = 2,000, Customer now owes = 12,000`. A debit note never modifies the original invoice/payable — it's an independent financial document that increases an existing obligation while preserving full accounting history, generated for additional charges, price corrections, underbilling adjustments, late fees, returned-cheque bank charges, tax adjustments, shipping corrections, contractual penalties, or (unlike Credit Note) a vendor-side charge too.

## Party-aware design — a real divergence from the spec, not a stylistic one
Credit Note (Part 10) is customer/AR-only. This spec's own Business Scenarios explicitly include a **Vendor** case ("Vendor Additional Charges -> Increase Payable -> Ledger Updated"), and its single Endpoint Contract gives one generic `invoiceId` request field for both. That field cannot work uniformly in this actual codebase: reading `models/AccountsPayableModel.js` in full (per this project's permanent pre-flight/analyze-first discipline) shows AP payables carry only a plain `invoiceNumber` **string** with no ref to any Invoice-equivalent — **no VendorInvoice model exists anywhere in this codebase** (the same gap Part 6 itself already documented for Vendor). So `DebitNoteModel` adds a `partyType: "Customer" | "Vendor"` discriminator: `"Customer"` requires `invoiceId` (ref `invoice`, validated the same way Credit Note validates its invoice); `"Vendor"` requires `payableId` (ref `accounts_payable`, referencing the payable directly since there's nothing upstream of it to reference). `middleware/validateRequest.js`'s `debitNoteSchemas.createDebitNote` enforces this with Joi `.when("partyType", ...)` conditionals — `invoiceId`/`payableId` are mutually exclusive and required based on `partyType`, not just optional.

## Lifecycle interpretation
`Draft -> Pending Approval -> Approved -> Issued -> Allocated -> Closed`, with `Cancelled` (any pre-Issued state) and `Voided` (Issued only, pre-allocation) as side exits — identical gated-states reasoning and the identical Issued/Allocated split as Credit Note (Issued finalizes the document with no AR/AP effect yet; Allocated is what actually posts to Accounts Receivable/Payable and the Ledger, keeping a void-before-consequence window).

**No separate `reject()` endpoint**, even though this spec's own Lifecycle diagram (unlike Credit Note's) explicitly draws "Rejected" as an alternative-flow outcome. The Domain Events list has no `DebitNoteRejected` — same rule as every other module in this codebase: an endpoint only gets built for a state a named event actually reaches. `cancel()` already covers "this debit note doesn't proceed."

**"Paid" is deliberately not a dead end here.** Every other AR/AP mutation in this codebase (`allocatePayment`, `writeOff`, `applyCreditNote`) is blocked once a receivable/payable reaches `TERMINAL_STATUSES` (`Paid`/`Settled`/`Written Off`/`Cancelled`) — but a Debit Note's entire purpose is to reopen an already-settled obligation and charge more. `AccountsReceivableService.applyDebitNote`/`AccountsPayableService.applyDebitNote` use a narrower `DEBIT_NOTE_BLOCKED_STATUSES` (`Written Off`/`Cancelled` only) instead, and flip a `"Paid"` receivable/payable back to `"Partially Paid"` once the new balance is no longer zero.

## Tax Adjustments — no original line to recalculate from
Credit Note's `computeCreditLineTotals` recalculates tax against the *original invoice line's* `taxCode` because every credit line references one (`invoiceLineId`). A debit note line has no such reference — the spec's own request example (`{"description": "Urgent Processing", "amount": 150}`) shows debit note items are **new charges**, not adjustments to an existing line. `computeDebitLineTotals` instead accepts an optional caller-supplied `taxCode` per line, validated against `config.taxCodes` (`InvoiceService.resolveTaxRate` already throws on an unknown code — no new validation invented).

## No "remaining creditable" cap analog
Credit Note enforces "Validate Remaining Credit" (total issued credits can't exceed the invoice's `grandTotal`) because a credit has a natural ceiling — you can't credit more than was billed. Increasing an obligation has no such ceiling, and this spec's own Validation Rules list for the create endpoint names no cap (`Invoice Exists`, `Invoice Active`, `Adjustment Valid`, `Financial Period Open`, `Currency Supported`, `Tenant Match` — no "remaining debitable amount"). None was invented.

## Accounts Receivable / Accounts Payable integration
`allocateDebitNote` dispatches to `AccountsReceivableService.applyDebitNote` (Customer) or `AccountsPayableService.applyDebitNote` (Vendor), both of which simply add the debit note's `grandTotal` straight onto `outstandingBalance` — no overpayment-split math is needed here (unlike Credit Note's reuse of `computeOverpaymentSplit`), since increasing a balance has no "excess" to peel off.

## Ledger posting — an honest new gap, handled the same way Part 5/6 already handle it
Credit Note's allocation journal reuses `defaultRevenueAccountCode`/`arControlAccountCode` because it's the exact mirror-reversal of an existing invoice-creation journal. A debit note has no such fixed counterpart account on either side — crediting *more* revenue (Customer) or debiting *more* expense (Vendor) needs a caller-chosen GL code, and no config-wide account code exists for either. This is the identical gap `AccountsReceivableService.createReceivable`'s `revenueAccountCode` and `AccountsPayableService.createPayable`'s `expenseAccountCode` already solved for their own creation journals: `DebitNoteModel.glAccountCode` is an optional caller-supplied field at creation time, used only at allocation to post Debit AR Control / Credit `glAccountCode` (Customer) or Debit `glAccountCode` / Credit AP Control (Vendor). Ledger posting is skipped entirely when it isn't supplied — same "skip posting until configured" fallback as every other optional account code in this module.

## `OutstandingBalanceIncreased` and `AdditionalChargeApplied` — no distinguishing trigger given
The spec's Domain Events list names both with no description separating when one fires versus the other. Rather than invent an arbitrary distinction (e.g. gating one behind a specific `reason` value), `allocateDebitNote` fires both together, honestly, every time.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/debit-notes

## Permission
`finance.debitnote.create`

## Request Example (Customer)
```json
{
  "partyType": "Customer",
  "invoiceId": "665f1c2e8b3a4d0012a4e111",
  "reason": "Additional Charges",
  "items": [
    { "description": "Urgent Processing", "amount": 150, "taxCode": "VAT" }
  ]
}
```

## Request Example (Vendor)
```json
{
  "partyType": "Vendor",
  "payableId": "665f1c2e8b3a4d0012a4e999",
  "reason": "Contractual Penalty",
  "items": [
    { "description": "Late Delivery Penalty", "amount": 500 }
  ]
}
```

## Business Workflow
Validate Invoice (Customer) or Payable (Vendor) exists and is not Draft/Cancelled/Voided/Written Off -> Calculate Taxes (per-line, from an optional caller-supplied `taxCode`) -> Generate Debit Number -> Generate PDF -> Timeline -> Audit -> Publish `DebitNoteCreated`.

## Validation Rules
`partyType` is `Customer` or `Vendor`; the matching `invoiceId`/`payableId` is required and the other is forbidden; the referenced invoice/payable was actually issued/approved; `reason` is one of the configured `debitNoteReasons`; every line item has a positive `amount` and (if supplied) a recognized `taxCode`; financial period open.

## Domain Events
`DebitNoteCreated`

---

# Endpoint Contract: GET /api/v1/debit-notes

## Permission
`finance.debitnote.read`

Filters: `partyType`, `customerId`, `vendorId`, `invoiceId`, `payableId`, `status`, `reason`, `currency`, `dateFrom`, `dateTo`, pagination/sort.

---

# Endpoint Contract: GET /api/v1/debit-notes/{debitNoteId}

## Permission
`finance.debitnote.read`

Includes the audit-log summary, same pattern as every other Finance resource's detail endpoint.

---

# Endpoint Contract: POST /api/v1/debit-notes/{debitNoteId}/approve

*(Gap-fill — same single configurable approval gate as Credit Note/Journal/AP/Invoice.)*

## Permission
`finance.debitnote.approve`

## Domain Events
`DebitNoteApproved`

---

# Endpoint Contract: POST /api/v1/debit-notes/{debitNoteId}/issue

*(Gap-fill — Approved -> Issued has no other trigger given, mirrors Credit Note's own issue step.)*

## Permission
`finance.debitnote.issue`

## Business Rules
Re-validates the financial period before finalizing the PDF.

## Domain Events
`DebitNoteIssued`

---

# Endpoint Contract: POST /api/v1/debit-notes/{debitNoteId}/allocate

*(Gap-fill — `DebitNoteAllocated` is a named domain event with no endpoint contracted for it. This is where "Update AR/AP -> Generate Journal -> Update Ledger" from the spec's own Business Workflow actually happens — see "Accounts Receivable / Accounts Payable integration" above for why it's a separate step from Issue.)*

## Permission
`finance.debitnote.issue`

## Domain Events
`DebitNoteAllocated`, `OutstandingBalanceIncreased` (fired by this service and, carrying `receivableId`/`payableId`, by AR/AP's own `applyDebitNote`), `AdditionalChargeApplied` (see "no distinguishing trigger given" above).

---

# Endpoint Contract: POST /api/v1/debit-notes/{debitNoteId}/cancel

*(Gap-fill. Covers Draft/Pending Approval/Approved — see "No separate reject() endpoint" above.)*

## Permission
`finance.debitnote.cancel`

## Domain Events
`DebitNoteCancelled`

---

# Endpoint Contract: POST /api/v1/debit-notes/{debitNoteId}/void

*(Gap-fill. Issued only, pre-allocation — once AR/AP has been touched, use its own mechanisms instead, same rule as Credit Note's void.)*

## Permission
`finance.debitnote.cancel`

## Domain Events
`DebitNoteVoided`

---

# Endpoint Contract: POST /api/v1/debit-notes/{debitNoteId}/close

*(Gap-fill. Allocated -> Closed only, manual.)*

## Permission
`finance.debitnote.issue`

## Domain Events
`DebitNoteClosed`

---

# Domain Events (Part 11 Summary)

`DebitNoteCreated`, `DebitNoteApproved`, `DebitNoteIssued`, `DebitNoteAllocated`, `OutstandingBalanceIncreased`, `AdditionalChargeApplied`, `DebitNoteCancelled`, `DebitNoteVoided`, `DebitNoteClosed` (fired for audit-trail symmetry with every other module's terminal action, same as Credit Note's own).

## Deferred / not built this pass
- **Financial Adjustment Engine** and **Financial Document Platform** — both architecture proposals from this spec (and Part 10's own forward note) were deliberately NOT built. Credit Note and Debit Note turned out to diverge more than converge once actually implemented: Credit Note validates against an *existing invoice line* and enforces a remaining-creditable cap; Debit Note is party-aware (Customer vs. Vendor, a dimension Credit Note doesn't have at all) and has no cap. A shared "Financial Adjustment Engine" would have had to abstract over both of those real differences from day one, for no concrete consumer beyond these two modules. If a third adjustment type (e.g. Tax Adjustment) is ever actually built, extracting shared numbering/PDF/audit plumbing at that point — once three real implementations exist to generalize from — would be the evidence-based time to do it, not now.
- **Vendor debit note without an existing AP payable** — since no VendorInvoice model exists, a Vendor debit note can only be raised against an *existing* `AccountsPayableModel` record, not an arbitrary vendor charge with no prior payable. This matches the spec's own request shape (`invoiceId`-style reference required) — it was never designed for a payable-less vendor charge either.

---

# Part 12 — Enterprise Refund Management APIs

## Overview
"Credit Note is an accounting document. Refund is the actual movement of money." A Refund is independent from a Credit Note, though the two are commonly linked: `Invoice Paid -> Customer Cancels -> Credit Note Created -> Refund Approved -> Money Returned -> Ledger Updated`. This part closes two boundaries this doc has flagged before it was written: `PaymentService.refund` (Part 7) only refunds a payment's *unallocated* portion (already-allocated money — e.g. applied to a receivable — was a deliberately deferred scope boundary); and Credit Note's `RefundRequested` event (Part 10, fired when `disposition: "Refund"`) was a real signal with no consumer until now.

## Two independent, real creation paths — not one generic shape
The spec's own request example (`{paymentId, refundAmount, reason}`) is the "Refund without Credit Note" case — a direct refund against a payment, most useful for still-unallocated money (deposits, overpayments). The "Credit Note + Refund" case (the diagram above, and the most common of the three per this Part's own framing) instead supplies `creditNoteId`: `RefundService.createRefund` validates the credit note's `disposition === "Refund"`, that it has already been `Allocated`/`Closed` (Accounts Receivable was already adjusted by Credit Note's own allocation step), and that its linked `customerCreditId` still has an `Active` balance — then caps `refundAmount` at that credit's `remainingAmount`. **Neither path touches Accounts Receivable.** For the direct-payment path there's nothing to touch (refunding unallocated money never reached AR). For the credit-note-linked path, AR was already reduced by the Credit Note itself — Refund's only job is the cash leg, exactly matching this Part's own rule. `paymentId` and `creditNoteId` aren't mutually exclusive at the schema level — a caller who knows exactly which original payment to route an "Original Gateway" refund through can supply both.

## Redeeming a Credit Note's own CustomerCredit — `CustomerCreditService.consumeCreditById`
`CreditNoteService.allocateCreditNote` (Part 10) already creates a real `CustomerCredit` for the *entire* refund amount when disposition is `"Refund"` (the excess-beyond-outstanding-balance portion becomes credit regardless of disposition — see Part 10's own doc). Converting that into an actual cash/wallet payout means redeeming that *specific* credit record, not FIFO-consuming across every Active credit the customer has (which is what `consumeAvailableCredits`, used by AR/AP creation, already does and would be wrong here — it could drain an unrelated, older credit instead). A new targeted method, `consumeCreditById(creditId, tenantId, amount)`, was added for exactly this.

## Refund Eligibility — hard rules vs. advisory risk
The spec's "Refund Eligibility... Checks" list mixes two different kinds of checks, and this implementation keeps them separate on purpose:
- **Hard, blocking rules** (`RefundService.computeRefundEligibility`): Payment Status (`isPaymentRefundable`, reused directly from `PaymentService.js`, not duplicated), Credit Note validity (disposition/status/linked-credit checks above), Business Rules (a positive amount that doesn't exceed the remaining refundable amount — computed from `payment.amount - payment.refundedAmount - every non-terminal-failed refund already reserved against it`, or the linked credit's own `remainingAmount`), Time Window (`refundWindowDays` since the original payment's `transactionDate`; `0` = unlimited). Any failure here is a real validation error — creation is rejected.
- **Fraud Risk — "AI advisory only"** (`RefundService.computeRefundRiskScore`): rule-based (not AI, matching this codebase's own established stance on every other "fraud"-labeled check — see Part 7's own Deferred section), scoring Duplicate Refund / High Refund Frequency / High Amount. Deliberately **reuses Part 7's own fraud threshold env vars** (`FRAUD_DUPLICATE_WINDOW_MINUTES` etc.) rather than a parallel set — same conceptual check, applied against `RefundModel` instead of `PaymentModel`. This score is stored on the refund for the approver to see and **never blocks creation**, matching the spec's own "AI advisory only" instruction and the same non-blocking precedent `PaymentModel.fraudCheck` already set.

## Approval Policy — the "Amount Based" option, actually implemented
Every other approval gate in this codebase (Journal/Invoice/Credit Note/Debit Note) is a single on/off boolean, because no concrete thresholds were ever specified to build a real tiered policy against. This spec's own "Approval Policies" list includes "Amount Based," and this time a real threshold is buildable without guessing: `isRefundApprovalRequired(amount, config)` requires approval when EITHER `refundApprovalRequired` (the familiar boolean) is true OR `refundAmount >= refundApprovalAmountThreshold` (`0`/unset = no threshold-forced approval). A refund that doesn't require approval is created directly into `"Approved"` (both `RefundRequested` and `RefundApproved` fire at creation, `approvedBy: "system"`) rather than sitting in `"Requested"` for a rubber-stamp. Still not the full CFO/Finance-Manager tiered role chain the spec lists — no such role concept exists in this codebase beyond permission keys, same call already made for every other module's approval gate.

## Lifecycle interpretation
`Requested -> Under Review -> Approved -> Processing -> Completed`, with `Rejected`/`Cancelled`/`Failed` as side exits — the Lifecycle diagram's five distinct states are the real contract (same reading applied identically to every gated-lifecycle module this session), even though the Business Workflow paragraph collapses several of them into one "Approval Workflow" step. **`Under Review` has no dedicated domain event** — the Domain Events list has no `RefundUnderReview` — so `reviewRefund` updates state/timeline/audit only, honestly, with no invented event name (contrast with `reject`, below).

**Unlike Credit Note/Debit Note, `reject()` gets its own dedicated endpoint here.** Those two modules folded "this doesn't proceed" into `cancel()` specifically because their specs named no `Rejected` event. This spec's Domain Events list explicitly names `RefundRejected` — so, following this session's own established rule (an endpoint only gets built for a state a named event actually reaches), Refund gets both `reject()` (pre-approval, "we're declining this") and `cancel()` (any pre-processing state, "this isn't needed anymore") as genuinely distinct actions.

**`process()` runs Approved -> Processing -> Completed/Failed synchronously**, in one call. "Supports asynchronous callbacks" (Gateway Refund section) is honestly deferred — this codebase has no webhook receiver anywhere to complete a refund later from a gateway callback, the same category of deferral as Payment's own synchronous authorize+capture (Part 7).

## Refund Methods — real dispatch, not a label
`processRefund` dispatches on `refundMethod`:
- **Original Gateway** — calls the real adapter (`services/gateways/`) against the *original payment's* `gatewayDetails.transactionId`, the same adapter contract `PaymentService.refund` already uses. Requires `paymentId` at creation (enforced by both the Joi schema's implicit requirement and a service-level check) — there's no such thing as an "Original Gateway" refund with no original payment to reference.
- **Customer Wallet / Store Credit** — creates a real, immediately-usable `CustomerCredit` (`source: "RefundAdjustment"`, a value `CustomerCreditModel.source` already declared as valid back in Part 5, unused until now — the same "close a documented placeholder" pattern Part 10 and Part 11 each already did once). If linked to a credit note, the specific credit it produced is redeemed first via `consumeCreditById`.
- **Bank Transfer / Cash / Cheque / Custom Method** — settle instantly; no external API exists for any of these (same category as `ManualGatewayAdapter`).

Ledger posting happens once money-movement succeeds: Debit `defaultRevenueAccountCode` (a refund is a revenue reversal) / Credit `defaultCashAccountCode` for the three real-cash-out methods above, or / Credit `customerCreditLiabilityAccountCode` for Wallet/Store Credit (no cash has left yet — a liability was created instead, the identical account this codebase already uses for overpayment credit). Same "skip posting until both codes are configured" fallback as every other optional account code in this module. `Payment.refundedAmount`/`unallocatedAmount` are updated too, but only the portion still genuinely unallocated on the payment comes off `unallocatedAmount` — money already allocated elsewhere (applied to AR, then separately reduced by a Credit Note) is never double-subtracted.

## Event-bus auto-creation from `RefundRequested`
`RefundService.initEventListeners()` (wired into `server.js`'s bootstrap alongside the other Finance listeners) subscribes to `RefundRequested` and, when the payload carries `creditNoteId` (Part 10's own shape — the direct-payment creation path never emits that field), auto-creates a Refund document through the normal `createRefund` path, defaulting `refundMethod` to `"Bank Transfer"` (a safe method that needs no `paymentId`, since Part 10's own event payload never carries one — see Part 10's doc for why a credit note has no single originating payment). Because `createRefund` itself also publishes `RefundRequested` on the direct-creation path, the listener guards against re-triggering itself off its own publish by requiring `payload.creditNoteId` and short-circuiting if a Refund already exists for that credit note. Auto-creation still goes through the normal approval gate — it never auto-processes money movement. This is the real, honest Finance-to-Finance event flow the architecture doc's "business modules publish events; Finance consumes them" principle describes, just with both ends inside Finance itself.

## Chargebacks — deliberately its own small resource, not a Refund status
The spec's Refund Lifecycle diagram lists "Chargeback" as one of the Refund's own alternative-flow outcomes, and `refundStatuses` (`utils/financeConfig.js`) deliberately does **not** include it. A chargeback is a bank/card-network-forced event against the original **Payment** — `PaymentModel`'s own `paymentStatuses` (Part 7) already names `"Chargeback"` as a real status with no endpoint to ever reach it, an honest Part-7 gap this Part closes (the same "close a documented placeholder" pattern used repeatedly this session, this time reaching back two parts instead of one). `ChargebackModel` is its own small collection, linked to `paymentId` (required) and optionally `refundId`, with its own lifecycle: `Open -> Evidence Submitted -> Under Appeal -> Won | Lost`. "Appeals" (spec bullet) is represented by resubmitting evidence while already `Evidence Submitted` (moves to `Under Appeal`; further evidence while already `Under Appeal` stays there) — not a separate state machine, since the spec names no distinct "Appeal" endpoint or event. "Evidence Upload" reuses this codebase's existing generic document storage abstraction — `evidenceUrls` are URL strings the caller already obtained via the existing upload path; this module does not implement a parallel upload pipeline. Filing a chargeback (`createChargeback`) immediately flips `payment.status` to `"Chargeback"` — it's a record of something that already happened (the bank already pulled the funds), not a request awaiting our approval, so there's no Requested/Approved gate the way Refund has one. Resolving `"Won"` reverts `payment.status` to `"Captured"` with no ledger posting (mirroring that none was posted when the dispute opened either — this codebase only recognizes the gain/loss once a dispute is FINAL); resolving `"Lost"` posts a real loss journal (Debit `chargebackLossExpenseAccountCode`, falling back to `defaultRevenueAccountCode` if unset / Credit `defaultCashAccountCode`) and leaves `payment.status` at `"Chargeback"` (terminal).

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/refunds

## Permission
`finance.refund.create`

## Request Example (direct payment refund — the spec's own example)
```json
{
  "paymentId": "665f1c2e8b3a4d0012a4e111",
  "refundAmount": 450,
  "reason": "Visa Rejected"
}
```

## Request Example (Credit Note + Refund)
```json
{
  "creditNoteId": "665f1c2e8b3a4d0012a4e222",
  "reason": "Service Cancellation",
  "refundMethod": "Bank Transfer"
}
```

## Business Workflow
Validate Payment and/or Credit Note -> Validate Refund Eligibility (hard rules) -> Validate Remaining Refund Amount -> Fraud Risk scoring (advisory) -> Approval Workflow (auto-approved if below the configured gate) -> Generate Refund Number -> Timeline -> Audit -> Publish `RefundRequested` (and `RefundApproved` if auto-approved).

## Validation Rules
Either `paymentId` or `creditNoteId` supplied; `paymentId` required when `refundMethod` is `"Original Gateway"`; the payment (if given) is in a refundable status; the credit note (if given) has `disposition: "Refund"`, is `Allocated`/`Closed`, and has an Active linked credit; `refundAmount` does not exceed the remaining refundable amount; within the configured refund time window; financial period open.

## Domain Events
`RefundRequested`, `RefundApproved` (only when auto-approved)

---

# Endpoint Contract: GET /api/v1/refunds

## Permission
`finance.refund.read`

Filters: `customerId`, `paymentId`, `creditNoteId`, `status`, `refundMethod`, `currency`, `dateFrom`, `dateTo`, pagination/sort.

---

# Endpoint Contract: GET /api/v1/refunds/{refundId}

## Permission
`finance.refund.read`

Includes the audit-log summary, same pattern as every other Finance resource's detail endpoint.

---

# Endpoint Contract: POST /api/v1/refunds/{refundId}/review

*(Gap-fill — the Lifecycle diagram's own "Under Review" state, no dedicated event named for reaching it.)*

## Permission
`finance.refund.approve`

---

# Endpoint Contract: POST /api/v1/refunds/{refundId}/approve

## Permission
`finance.refund.approve`

## Domain Events
`RefundApproved`

---

# Endpoint Contract: POST /api/v1/refunds/{refundId}/reject

*(Unlike Credit Note/Debit Note, this spec names `RefundRejected` explicitly — a real, dedicated endpoint, not folded into cancel.)*

## Permission
`finance.refund.approve`

## Domain Events
`RefundRejected`

---

# Endpoint Contract: POST /api/v1/refunds/{refundId}/process

*(Gap-fill — `RefundProcessing`/`RefundCompleted`/`RefundFailed` are named domain events with no endpoint contracted for them. This is where the actual money movement happens — see "Refund Methods" above.)*

## Permission
`finance.refund.process`

## Domain Events
`RefundProcessing`, then `RefundCompleted` or `RefundFailed`

---

# Endpoint Contract: POST /api/v1/refunds/{refundId}/cancel

## Permission
`finance.refund.cancel`

## Domain Events
`RefundCancelled`

---

# Endpoint Contract: POST /api/v1/refunds/chargebacks

*(Gap-fill — grouped under Refund Management per the spec's own Business Purpose list and Domain Events.)*

## Permission
`finance.chargeback.create`

## Request Example
```json
{
  "paymentId": "665f1c2e8b3a4d0012a4e111",
  "amount": 450,
  "reason": "Cardholder disputes the charge",
  "gatewayDisputeId": "dp_1AbCdEfGh"
}
```

## Domain Events
`ChargebackCreated`

---

# Endpoint Contract: GET /api/v1/refunds/chargebacks

## Permission
`finance.chargeback.read`

Filters: `paymentId`, `status`, `currency`, `dateFrom`, `dateTo`, pagination/sort.

---

# Endpoint Contract: GET /api/v1/refunds/chargebacks/{chargebackId}

## Permission
`finance.chargeback.read`

---

# Endpoint Contract: POST /api/v1/refunds/chargebacks/{chargebackId}/evidence

*(Gap-fill. No dedicated domain event named for this transition — none invented.)*

## Permission
`finance.chargeback.manage`

---

# Endpoint Contract: POST /api/v1/refunds/chargebacks/{chargebackId}/resolve

*(Gap-fill — `ChargebackResolved` is a named domain event with no endpoint contracted for it.)*

## Permission
`finance.chargeback.manage`

## Domain Events
`ChargebackResolved`

---

# Domain Events (Part 12 Summary)

`RefundRequested` (also published by `CreditNoteService.allocateCreditNote`, Part 10 — this Part is its real consumer), `RefundApproved`, `RefundRejected`, `RefundProcessing`, `RefundCompleted`, `RefundFailed`, `RefundCancelled`, `PaymentRefunded` (fired again here — already existed on `PaymentService.refund`, Part 7 — when a refund fully settles a payment), `ChargebackCreated`, `ChargebackResolved`.

## Deferred / not built this pass
- **Financial Transaction Platform** — this spec's own "Principal Software Architect Recommendation" proposing a platform spanning Payment/Refund/Settlement/Gateway/Wallet/Fraud/Reconciliation/Audit engines was deliberately NOT built, for the identical reason Part 11 gave for skipping its own "Financial Adjustment Engine": no concrete shared-interface requirement was given, and Refund's own logic (eligibility rules, the two independent creation paths, method-specific dispatch) is already fairly Refund-specific. Extract shared plumbing only once a third, genuinely-converging module is actually built.
- **Asynchronous gateway refund callbacks** — `processRefund` is synchronous end-to-end; no webhook receiver exists anywhere in this codebase to complete a refund later from a gateway's own async confirmation.
- **Country Check / Blacklisted Customer fraud signals** — same honest omission Part 7 already made for Payment's own fraud check: no country/IP field or blacklist flag exists anywhere in this codebase to check against.
- **A full CFO/Finance-Manager tiered approval role chain** — "Amount Based" is real and implemented (see above); the specific named roles (Finance Manager, CFO) aren't, since no such role concept exists in this codebase beyond permission keys.

---

# Part 13 — Enterprise Bank Accounts APIs

## Overview
"A bank account is not just a database record. It is the source of truth for cash movement." This Part builds the Enterprise Banking Platform as a real, dedicated module — full lifecycle, encrypted-at-rest account numbers, a genuinely mutating multi-type balance engine, virtual accounts, settlement links, and — the part that actually makes the user's own framing true rather than aspirational — a real event-driven integration with the two money-movement modules that already exist (Payment, Refund), so a bank account's balance changes for real the moment a payment captures or a refund completes.

## Tenant-only — the spec's branch language dropped entirely
Per the standing master instructions (§3), every "Branch Bank Accounts"/"Branch Isolation"/"Branch Match" reference and the request example's own `branchId` field are dropped. There is no branch dimension anywhere in `BankAccountModel`, `BankAccountService`, or the Joi schemas — "Validate Organization"/"Legal Entity Exists" (Validation Rules) collapse into the tenant check `getAccessScope(req)` already performs on every request; no separate Organization/Legal Entity model exists in this codebase to validate against beyond the tenant itself, and none was invented.

## Account number security — real encryption, real masking, and why uniqueness needed a third field
"Account Number (Masked)" (GET response) and "Encryption" (Security section) are both taken literally, not just documented as aspirations:
- **`utils/fieldEncryption.js`** (new, reusable) — AES-256-GCM, mirroring `controllers/Auth.js`'s own `encryptMfaValue`/`decryptMfaValue` exactly (same algorithm, same SHA-256 key derivation), kept as its own independent implementation rather than a refactor of Auth.js's private functions, so a change here can never affect MFA secret handling. The key is `BANK_ACCOUNT_ENCRYPTION_KEY` if set, falling back to the already-mandatory `MFA_ENCRYPTION_KEY` — real and available by default without requiring a second mandatory startup secret.
- **The uniqueness problem**: "Unique Account Number" can't be enforced with a DB unique index on the encrypted ciphertext — AES-GCM uses a fresh random IV every time, so encrypting the same plaintext twice never produces equal ciphertext. `accountNumberHash` (a one-way SHA-256 hash of the normalized number, same hashing convention `Auth.js` already uses for reset/verification tokens) is the field the real unique-per-tenant index and duplicate-detection actually run against — used only for equality checks, never for display or decryption.
- **Masking**: `accountNumberLast4` is denormalized at creation specifically so `****1234` can be rendered on every list-page read without decrypting anything. The model's own `toJSON` (and `BankAccountService._sanitize` for the `.lean()` query paths that skip Mongoose's transform) strip `accountNumberEncrypted`/`accountNumberHash` unconditionally — neither the ciphertext nor the hash ever reaches a client response.

## Lifecycle interpretation — "Created" and "Operational" are not separate resting states
The Lifecycle diagram draws five sequential positive-flow states (`Created -> Pending Verification -> Verified -> Active -> Operational`), more than any other module's own lifecycle this session, but only three have named domain events (`BankAccountCreated`, `BankAccountVerified`, `BankAccountActivated`):
- **"Created"** isn't used as its own resting `status` value — a brand-new account starts directly in `"Pending Verification"` (`defaultBankAccountStatus`); `BankAccountCreated` still fires at that same creation moment regardless of which status string is assigned, matching how every other module in this codebase fires its own `XCreated` event at real creation, not at some later step.
- **"Pending Verification" -> "Verified"** (`verifyBankAccount`) represents finance-ops manually confirming the bank details are correct — a genuine real-world control, since no Open Banking/SWIFT integration exists anywhere in this codebase to verify a bank account automatically (see Deferred, below).
- **"Verified" -> "Active"** (`activateBankAccount`) is the account's real go-live moment.
- **"Active" and "Operational"** are treated as one real state. No event is named for "Operational," and nothing in the spec describes a distinguishing trigger between it and "Active" — same honest-collapse call already made once for AP's Approved->Open and once for Debit Note's Issued/Allocated pairing this session.

Alternative flows: `freeze` (the whole account stops transacting — `BankAccountFrozen`), `reopen` (gap-fill — "Reopen Account" is named only under Approval Policies, no Lifecycle arrow or event of its own; Frozen/Suspended -> Active), `suspend` (gap-fill, no event named), `close` (`BankAccountClosed`, blocked while the account's `balances.current` is non-zero — a real safety rule, not just a status flip), `archive` (gap-fill, Closed only, no event named).

## Two distinct freezing mechanisms — not one
The spec's own "Balance Types" list (`Current`, `Available`, `Frozen`, `Pending Settlement`, `Reserved Funds`) and its separate Lifecycle "Frozen" alternative-flow state describe two genuinely different mechanisms, both built:
- **Account-level `freeze()`** — the whole account stops accepting any transaction (`applyTransaction` checks `isBankAccountTransactable`, which only `"Active"` satisfies).
- **`hold()`/`releaseHold()`** (gap-fill) — reserves part of an otherwise-Active account's balance (moves money from `available` into `frozen` without touching `current`); the account keeps transacting normally around the hold. "Frozen Balance" and "Reserved Funds" are treated as the same `balances.frozen` field — the spec names no distinguishing trigger between those two Balance Types either. Because no real cash moves on a hold, it does **not** write a `BankTransactionModel` entry (that ledger represents actual money movement only) — the account's own `timeline[]` and `AuditLogModel` carry a hold's audit trail instead.
- **`balances.pendingSettlement`** is structurally present on the schema (matching the spec's own Balance Types list) but stays functionally `0` this pass — its mover would be a Settlement Engine, named only in this Part's own architecture diagrams and deliberately not built (see Deferred).

## The real Balance Engine — `BankTransactionModel` and `applyTransaction`
"Immutable Transaction History" (AI Coding Rule) and the `BalanceUpdated` domain event needed a real backing ledger, not just a mutable number on the account document. `BankTransactionModel` (new) is that ledger — append-only, one row per real money movement, carrying a `balanceAfter` snapshot independent of the account's own live `balances.current`. `BankAccountService.applyTransaction` is the one internal primitive every real balance mutation in this module goes through (never exposed as its own endpoint directly); `BankAccountModel.balances` is kept in sync by it, the same "store the real running number, mutate it precisely at each event" discipline `InvoiceModel.outstandingBalance` already established, not a live aggregation recomputed on read.

## Virtual Accounts — redirect, not a parallel balance
"Virtual Accounts... Automatically mapped to master account" is implemented as a real redirect: a virtual account (`isVirtual: true`, `parentAccountId` set) never carries its own real balance — `applyTransaction` resolves a virtual account straight to its `parentAccountId` before doing anything else, so every transaction against a virtual account's identifier actually credits/debits the master account. `createVirtualAccount` (gap-fill, for the named `VirtualAccountCreated` event) creates it directly `"Active"` rather than re-running Pending Verification -> Verified — a virtual account rides on its master's already-verified banking relationship; no separate bank verification is meaningful for it.

## The real integration: Payment and Refund now move real bank balances
This is the part that makes "interacts with almost every finance module" concrete rather than aspirational, for the two modules that actually exist and actually move money today (Payment, Part 7; Refund, Part 12 — Payroll/Vendor-Payments-as-a-distinct-flow/Treasury/Settlement don't exist as modules in this codebase; see Deferred):
- `PaymentModel`/`RefundModel` each gained an optional `bankAccountId` field — same "known when known, informational" stance `partyId` already has on Payment.
- Wired via the **event bus**, not a direct service-to-service call — `BankAccountService.initEventListeners()` (registered in `server.js`'s bootstrap alongside every other Finance listener) subscribes to `PaymentCaptured` and `RefundCompleted`, both of which now carry `bankAccountId` in their payload. When present, the listener calls `applyTransaction` for real: `resolvePaymentBankDirection(paymentType)` (Customer/Advance/Deposit = Credit/money in; Vendor/Employee = Debit/money out) for Payment, always `Debit` for Refund (refunding is always money going back out). A Payment/Refund created without a `bankAccountId` (every one created before this Part existed, and any new one that simply doesn't supply it) behaves exactly as before — nothing about Part 7/12's own contracts changed.
- This mirrors the identical cross-module event pattern `RefundService` already established subscribing to Part 10's `RefundRequested` — the real, reusable Finance-to-Finance wiring template this doc's own Part 12 "Next" note said would be available for whatever came next.

## Manual balance adjustments — real double-entry, not just a number change
`manualAdjustment` (gap-fill for the otherwise-unreachable `BalanceUpdated` event — opening balances, bank fees, interest, corrections) posts a genuine journal when the account's own `glAccountCode` is configured, mirrored against a new `bankAdjustmentSuspenseAccountCode` — the same "skip ledger posting until configured" fallback as every other optional account code in this module, never a silent, unbalanced number change.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/bank-accounts

## Permission
`finance.bankaccount.create`

## Request Example
```json
{
  "bankName": "Habib Bank",
  "accountName": "Operating Account",
  "accountNumber": "01234567890123",
  "currency": "PKR",
  "accountType": "Operating"
}
```

## Business Workflow
Validate Currency -> Validate Bank -> Validate Unique Account Number -> Approval Workflow -> Generate Account Code -> Encrypt Account Number -> Audit -> Publish `BankAccountCreated`.

## Validation Rules
`currency` is one of the tenant's supported currencies; `accountType` is one of the configured `bankAccountTypes`; the account number hasn't already been registered for this tenant; `glAccountCode` (if supplied) exists on this tenant's Chart of Accounts.

## Domain Events
`BankAccountCreated`

---

# Endpoint Contract: GET /api/v1/bank-accounts

## Permission
`finance.bankaccount.read`

Filters: `currency`, `status`, `bank`, `accountType`, `isVirtual`, pagination/sort. Every result's account number is masked (`accountNumberMasked`) — the encrypted value and its uniqueness hash never serialize into a response.

---

# Endpoint Contract: GET /api/v1/bank-accounts/{accountId}

## Permission
`finance.bankaccount.read`

Includes balances, authorized users, linked gateways, populated settlement accounts, the 20 most recent `BankTransactionModel` entries, and the audit-log summary.

---

# Endpoint Contract: PATCH /api/v1/bank-accounts/{accountId}

*(Gap-fill, mirrors ChartOfAccountController's own updateAccount precedent.)*

## Permission
`finance.bankaccount.manage`

Editable: `bankName`, `accountName`, `glAccountCode`, `linkedGateways`, `authorizedUsers`. `accountNumber`/`currency`/`bankAccountCode` are immutable after creation — close this account and open a new one instead, same standard banking practice `ChartOfAccountModel.accountCode`'s own immutability already reflects for GL accounts.

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/verify

*(Gap-fill.)*

## Permission
`finance.bankaccount.approve`

## Domain Events
`BankAccountVerified`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/activate

*(Gap-fill.)*

## Permission
`finance.bankaccount.approve`

## Domain Events
`BankAccountActivated`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/freeze

## Permission
`finance.bankaccount.manage`

## Domain Events
`BankAccountFrozen`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/reopen, /suspend, /archive

*(All three gap-fill — "Reopen Account" is named only under Approval Policies; "Suspended"/"Archived" have no domain events of their own.)*

## Permission
`finance.bankaccount.manage`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/close

## Permission
`finance.bankaccount.manage`

## Business Rules
Rejected while `balances.current` is non-zero.

## Domain Events
`BankAccountClosed`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/adjust-balance

*(Gap-fill — `BalanceUpdated` is a named domain event with no endpoint contracted to reach it directly.)*

## Permission
`finance.bankaccount.manage`

## Domain Events
`BalanceUpdated`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/hold, /release-hold

*(Gap-fill — real mechanisms for the spec's own "Frozen Balance"/"Reserved Funds" Balance Types.)*

## Permission
`finance.bankaccount.manage`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/virtual-accounts

*(Gap-fill — `VirtualAccountCreated` is a named domain event with no endpoint contracted for it.)*

## Permission
`finance.bankaccount.create`

## Domain Events
`VirtualAccountCreated`

---

# Endpoint Contract: POST /api/v1/bank-accounts/{accountId}/link-settlement-account

*(Gap-fill — `SettlementAccountLinked` is a named domain event with no endpoint contracted for it.)*

## Permission
`finance.bankaccount.manage`

## Domain Events
`SettlementAccountLinked`

---

# Endpoint Contract: GET /api/v1/bank-accounts/{accountId}/transactions

*(Gap-fill — the detail endpoint's own "Recent Transactions" is capped at 20; this is the full paginated ledger.)*

## Permission
`finance.bankaccount.read`

---

# Domain Events (Part 13 Summary)

`BankAccountCreated`, `BankAccountVerified`, `BankAccountActivated`, `BankAccountFrozen`, `BankAccountClosed`, `BalanceUpdated`, `VirtualAccountCreated`, `SettlementAccountLinked`.

## Deferred / not built this pass
- **Open Banking APIs, SWIFT, ISO 20022, host-to-host banking** — named only in this Part's own "Principal Software Architect Improvement" as future integrations "much easier" to add later, not required by any endpoint contract given. No live bank-verification or statement-fetching integration exists — `verifyBankAccount` represents a human confirming details, not a bank API call.
- **Treasury Platform / Enterprise Banking Platform as a separate generalized layer** — this Part's own two "Principal Software Architect" sections propose both a dedicated "Banking Platform" (Account Manager/Balance Engine/Virtual Account Manager/Treasury Manager/Settlement Manager/Authorization Engine as named sub-engines) and, above that, a "Treasury Platform" (Liquidity/Cash Position/Investment/Borrowing/FX/Risk/Forecast engines). Neither was built as a distinct architectural layer, for the identical reason Part 11/12 each already gave for skipping their own proposed platforms: `BankAccountService` already fills the "Banking Platform" role directly (it has real balance, virtual-account, and settlement-link logic — wrapping it in another layer of named sub-engine classes would be organizational theater over the same code), and Treasury (liquidity forecasting, FX exposure, investments, borrowing) has zero concrete endpoint contracts anywhere in this doc to build against.
- **Payroll, Vendor Payments as a distinct flow, Settlement Engine, Cash Management** — all named only in this Part's "Linked Services"/architecture diagrams, none exist as modules in this codebase (Part 7's own doc already noted "Vendor Payments" is superseded by `paymentType` on the unified Payment Engine, not a separate module). `balances.pendingSettlement` and `settlementAccountIds[]` are structurally present, ready for whichever of these ships first, functionally inert until then — the same "present but empty until its owning module exists" pattern used repeatedly this session.
- **A full CFO/Finance-Manager tiered approval policy matrix** for Create/Close/Freeze/Reopen/Change-Authorized-Users individually — one configurable boolean gate (`bankAccountApprovalRequired`) instead, same simplification call made for every other module's approval gate this session.

---

# Part 14 — Enterprise Bank Reconciliation APIs

## Overview
"Does the money in our ERP match the money shown by the bank?" This Part builds a real Import Engine (five genuine format parsers, not stubs), a real weighted Matching Engine scored against Part 13's own immutable `BankTransactionModel` ledger, a real Exception Engine (dedicated, resolvable records — not an inline status label), real "Automatic Journal Generation" for bank adjustments (by reusing Part 13's own `BankAccountService.manualAdjustment` rather than reimplementing it), and real AI-assisted match suggestions routed through this codebase's existing, already-wired multi-provider AI infrastructure.

## Tenant-only — the spec's branch language dropped entirely
Per the standing master instructions (§3), the request/validation-rule "Branch Match" and every other branch-isolation reference are dropped. No branch dimension exists anywhere in this Part's models, service, or Joi schemas.

## Real format parsers — five, not one generic stub
"Supported Formats: CSV, Excel, MT940, CAMT.053, OFX, Open Banking API, Custom Parser." Every one of the first six is implemented for real (`services/reconciliationParsers/`, mirroring `services/gateways/`'s own adapter-registry pattern):
- **CSV** (`csv-parse`) / **Excel** (`exceljs`) — flexible header-alias column detection (`rowMapping.js`) since real bank exports vary in wording; neither carries a native opening/closing balance, so the caller supplies those.
- **MT940** — a real SWIFT tag-grammar parser (`:20:`/`:25:`/`:28C:`/`:60F:`/`:61:`/`:86:`/`:62F:`), regex-based, handling the standard tag layout (documented honestly: banks with non-standard `:61:` extensions may need adjustment — the same real-world tolerance every MT940 parser, commercial or open-source, needs).
- **CAMT.053** (`fast-xml-parser`) — real ISO 20022 `BkToCstmrStmt/Stmt/Bal` (`OPBD`/`CLBD` balance codes) and `Ntry` entry parsing.
- **OFX** — real tag-regex extraction (deliberately not a strict XML parser, since OFX 1.x is SGML with tags that often have no closing tag on the same line); `BALAMT`/`DTASOF` become the closing balance, since OFX has no native "opening balance" concept.
- **Custom** — accepts a tenant-pre-shaped JSON transaction array directly, for banks whose own export tooling a tenant has already converted themselves, rather than this codebase guessing at an arbitrary undocumented format.

All five were verified against real, hand-built sample statements of each format during development (not just unit-tested in isolation) — see `tests/reconciliationParsers.test.js`.

**"Open Banking API" is deliberately excluded from `reconciliationImportFormats`.** No live Open Banking/aggregator integration (Plaid, TrueLayer, a specific bank's own API, ...) exists anywhere in this codebase, and no credentials for one are configured. Listing it as a supported format while having no real client behind it would be exactly the kind of fabricated integration this codebase's own conventions forbid — the parser registry (`services/reconciliationParsers/index.js`) is architected so adding a real one later (a `BaseStatementParser` subclass, one registry entry) requires no other change.

## A safer dependency choice: `exceljs` over `xlsx`
The obvious first choice for Excel parsing, `xlsx` (SheetJS), carries unpatched high-severity advisories on the npm registry (Prototype Pollution, ReDoS) with no fix available there. `exceljs` was installed instead — an actively maintained alternative with only a moderate, transitive advisory (via a stale bundled `uuid` in a dependency, not its own parsing logic) — a real security tradeoff made deliberately, not accidentally.

## The Matching Engine — real weighted scoring against Part 13's own ledger
`computeMatchScore` treats **direction and currency as hard filters** (a Credit statement line can never match a Debit ERP entry, full stop) and **amount/date/reference as the genuinely weighted, fuzzy dimensions** (`reconciliationMatchWeights`, default `{amount: 0.5, date: 0.3, reference: 0.2}`, normalized to sum to 1 regardless of a tenant's override). Amount and date each degrade linearly from 100 at an exact match to 0 at the edge of their configured tolerance (`reconciliationAmountTolerance`, `reconciliationDateToleranceDays`); reference similarity is a real Levenshtein-distance-based normalized score, not a placeholder. A pair auto-matches at/above `reconciliationAutoMatchThreshold` (default 85).

Auto-matching is greedy: each unmatched statement line is scored against every eligible ERP candidate (`BankTransactionModel` rows for the same bank account, within the configured lookback window of the statement date, excluding anything already claimed by a match on THIS OR ANY OTHER reconciliation for that account — overlapping monthly statements never double-claim the same ERP transaction) and the best-scoring candidate at/above the threshold wins. Manual matching (`POST .../match`) does **not** hard-block on a low score or a date/amount mismatch beyond the direction/currency filters — a human manually matching is precisely the override path for cases auto-matching's tolerance windows couldn't resolve; the computed score is still stored, informationally, alongside `matchMethod: "Manual"` for the audit trail.

## The ERP balance is computed from the ledger, not read from a cache
`BankReconciliationService._computeErpBalanceAsOf` sums Part 13's own `BankTransactionModel` (Credits minus Debits) up to and including the statement date — **not** the bank account's live `balances.current`. A live number would drift away from "the ERP's balance as of the statement date" the moment any newer, unrelated transaction posts to that account; summing the real immutable ledger up to a point in time is the correct, standard reconciliation semantic, and it makes Part 13's own "Immutable Transaction History" AI Coding Rule the literal source of truth for this Part's own central question, exactly as this doc's own Part 13 "Next" note predicted it would be used for.

## Real Exception Management — a dedicated, resolvable record per discrepancy
`BankReconciliationExceptionModel` gives each of the spec's own listed discrepancy types (`Duplicate`, `MissingERPEntry`, `MissingBankEntry`, and the schema-ready-but-not-yet-auto-generated `AmountDifference`/`CurrencyDifference`/`ReferenceMismatch`/`LateSettlement`, all valid `exceptionType` values a caller can still record manually) a queryable, independently resolvable row — not just an inline status label. Auto-matching generates `MissingERPEntry` for every statement line it couldn't match and `MissingBankEntry` for every ERP transaction in the lookback window nothing claimed (a real, useful signal for "outstanding cheque"/"pending deposit"/"settlement delay," per the user's own worked example); duplicate-shaped statement lines are flagged, never silently discarded. Manually matching or creating an adjustment auto-resolves any exception the action now explains.

## Bank Adjustments reuse Part 13 entirely — no balance mutation logic duplicated
"Bank Charges, Interest Income, FX Gain/Loss, Correction Entries — Automatic Journal Generation" is implemented by calling Part 13's own `BankAccountService.manualAdjustment` directly, not by reimplementing balance mutation or journal posting a second time. This required one small, safe refinement to Part 13's own `applyTransaction`/`manualAdjustment`: they now return `{ bankAccount, transaction }` (previously just the bank account) so this Part can link the real `BankTransactionModel` row back to the reconciliation session's own `adjustments[]` array — every existing caller (the internal event listeners, `BankAccountController.adjustBalance`) either already expected this shape or never used the old return value's contents, so nothing about Part 13's own public API contract changed.

## Two-step completion gate — Approved means reviewed, Completed means resolved
`Manual Review -> Approved -> Completed` are kept as genuinely separate gated states: **Approved** only means a reviewer has looked at the matching results and any exceptions generated so far; **Completed** requires every exception to be `Resolved`/`Ignored` first (a real, enforced gate — `completeReconciliation` throws naming the exact count of still-`Open` exceptions if any remain). This is the real enforcement of "the process of identifying, explaining, and resolving those differences" the user's own framing describes — a reconciliation can't be called finished while an unexplained discrepancy still exists.

**"Statement Imported" and "Auto Matching" are not resting `status` values.** The spec's own Business Workflow lists "Auto Match -> Generate Exceptions" as steps WITHIN the import endpoint, before `StatementImported` even publishes — so a freshly imported statement runs matching synchronously in the same call and lands directly on "Manual Review," the same "collapse a transient/instantaneous state into the next real resting one" call already made for Bank Account's "Created"/"Operational" in Part 13. **"Reopened" is an action** (`reopenReconciliation`, Approved/Completed -> Manual Review), not a resting status, for the identical reason.

## AI Matching — real, routed through this codebase's existing AI infrastructure, never fabricated
"Suggest Likely Match... AI suggestions require user approval" is implemented with a genuine LLM call through `AIModelRouterService.route` — the same real, already-wired multi-provider router (`@anthropic-ai/sdk`, `openai`, circuit breakers, fallback chains) `AIOrchestrationService` already uses elsewhere in this codebase, not a separate bespoke AI client. `suggestAiMatches` builds a real prompt from the actual unmatched statement lines and ERP candidates, requests strict JSON, and — critically — **never trusts the model's returned ids blindly**: every suggestion is filtered against the real candidate sets before being returned, so a hallucinated id can never reach the response. If no AI provider is configured/reachable, `AIModelRouterService.route` throws honestly (`AI_UNAVAILABLE`) and this method returns `{ aiAvailable: false, suggestions: [] }` rather than fabricating a response — the same honest-failure discipline this codebase's AI layer already enforces everywhere else. Nothing is ever applied automatically: `acceptAiSuggestion` is a thin wrapper over the normal `matchTransaction` path (tagged `matchMethod: "AI-Suggested"`), so an AI-sourced match goes through the exact same validation as a human-entered one.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/bank-reconciliation/import

## Permission
`finance.reconciliation.create`

## Request
`multipart/form-data` — field `file` (the statement) plus `bankAccountId`, `format`, and (only for formats without a native statement header — CSV/Excel/Custom can still override) `statementDate`/`openingBalance`/`closingBalance`/`currency`.

## Business Workflow
Upload Statement -> Validate File -> Parse Transactions -> Create Import Batch -> Auto Match -> Generate Exceptions -> Publish `StatementImported` -> Return Success — all synchronous, within this one call.

## Validation Rules
Supported format; bank account exists and isn't Archived; currency resolved from the file (or supplied) matches the bank account's own currency; statementDate/openingBalance/closingBalance resolved from the file or supplied; no existing reconciliation already claims this bank account + statement date (Duplicate Detection).

## Domain Events
`StatementImported`, `TransactionMatched` (per auto-match), `ExceptionCreated` (per generated exception)

---

# Endpoint Contract: GET /api/v1/bank-reconciliation

## Permission
`finance.reconciliation.read`

Filters: `bankAccount`, `statementDate`, `status`, `currency`, pagination/sort.

---

# Endpoint Contract: GET /api/v1/bank-reconciliation/{reconciliationId}

## Permission
`finance.reconciliation.read`

Includes open exceptions and the audit-log summary.

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/{reconciliationId}/auto-match

*(Gap-fill — re-runs matching after new exceptions are resolved or new ERP transactions appear; also called internally by import.)*

## Permission
`finance.reconciliation.match`

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/{reconciliationId}/match

## Permission
`finance.reconciliation.match`

## Request Example
```json
{
  "statementTransactionId": "665f1c2e8b3a4d0012a4e111",
  "erpTransactionId": "665f1c2e8b3a4d0012a4e222"
}
```

## Business Workflow
Validate Transactions -> Verify Amount -> Verify Date -> Create Match -> Update Difference -> Audit -> Publish `TransactionMatched`.

## Domain Events
`TransactionMatched`

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/{reconciliationId}/unmatch

*(Gap-fill — `TransactionUnmatched` is a named domain event with no endpoint contracted for it.)*

## Permission
`finance.reconciliation.match`

## Domain Events
`TransactionUnmatched`

---

# Endpoint Contract: GET /api/v1/bank-reconciliation/{reconciliationId}/transactions, /exceptions

*(Gap-fill — paginated statement-line and exception listings for this session.)*

## Permission
`finance.reconciliation.read`

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/exceptions/{exceptionId}/resolve

*(Gap-fill — real workflow continuation for the named `ExceptionCreated` event; no `ExceptionResolved` event is named, so none was invented.)*

## Permission
`finance.reconciliation.match`

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/{reconciliationId}/adjustments

*(Gap-fill for the named `BankAdjustmentCreated` event — reuses Part 13's own `BankAccountService.manualAdjustment` entirely; see "Bank Adjustments reuse Part 13" above.)*

## Permission
`finance.reconciliation.manage`

## Domain Events
`BankAdjustmentCreated`

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/{reconciliationId}/approve, /complete, /reject, /reopen, /archive

*(`approve`/`complete`/`reopen` are named domain events; `reject`/`archive` have none, so neither publishes one.)*

## Permission
`finance.reconciliation.approve` (approve/complete/reject), `finance.reconciliation.manage` (reopen/archive)

## Domain Events
`ReconciliationApproved`, `ReconciliationCompleted`, `ReconciliationReopened`

---

# Endpoint Contract: POST /api/v1/bank-reconciliation/{reconciliationId}/ai-suggest, /ai-accept

*(Gap-fill — see "AI Matching" above.)*

## Permission
`finance.reconciliation.match`

---

# Endpoint Contract: GET /api/v1/bank-reconciliation/{reconciliationId}/report, /report/export

*("Reconciliation Reports... Export supported." `/report` returns the full real JSON assembly — Statement Summary, Matched/Unmatched Transactions, Adjustments, Exceptions, Final Difference, Audit History; `/report/export` streams a real generated CSV of the same data. PDF export is deferred — see below.)*

## Permission
`finance.reconciliation.read`

---

# Domain Events (Part 14 Summary)

`StatementImported`, `TransactionMatched`, `TransactionUnmatched`, `ExceptionCreated`, `ReconciliationApproved`, `ReconciliationCompleted`, `BankAdjustmentCreated`, `ReconciliationReopened`.

## Deferred / not built this pass
- **Open Banking API ingestion** — no live aggregator integration/credentials exist in this codebase; the parser registry is ready for a real one to be added later without touching anything else.
- **PDF report export** — CSV export is real and built; a full multi-section reconciliation PDF (unlike Receipt/Invoice/Credit Note/Debit Note, each of which needed exactly one specific document template) is a bigger, genuinely separate template effort, honestly deferred rather than half-built.
- **AmountDifference/CurrencyDifference/ReferenceMismatch/LateSettlement auto-generation** — these `exceptionType` values are real and usable (a caller can record one manually via a future extension point), but `runAutoMatch` itself only ever auto-generates `Duplicate`/`MissingERPEntry`/`MissingBankEntry` — the other four would require additional heuristics (e.g. "close but not close enough" near-misses) beyond this pass's scope; not fabricated as if they were already wired.
- **Reconciliation Platform / Financial Reconciliation Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Reconciliation Platform" (pluggable parser framework, standalone Matching/Exception/Adjustment/Approval engines) and, above that, a "Financial Reconciliation Platform" spanning bank/gateway/POS/wallet/payroll/intercompany/treasury reconciliation. Neither was built as a distinct architectural layer, for the same reason given at every prior Part that proposed one: `BankReconciliationService` already fills the real role directly, and Gateway/POS/Wallet/Payroll/Intercompany/Treasury reconciliation have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 15 — Enterprise Cash Management APIs

## Overview
"Cash != Bank." Physical money (cash drawers, petty cash, safes, vaults, POS tills) and money at a financial institution have different business rules, risks, controls, and audit requirements — the user's own framing this Part opens with. This Part resolves the open design question Part 14's own doc note deliberately left unanswered ("a cash account may turn out to be a real specialization of the same Bank Account concept... a genuine design question for Part 15 to resolve on its own merits"): **Cash Management gets its own separate model family** (`CashLocationModel`/`CashTransactionModel`), not a specialization of `BankAccountModel`, even though that model's own `accountType` enum already listed `"Petty Cash"`. The user's own spec settles it explicitly.

## Tenant-only — the spec's branch language dropped entirely
Per the standing master instructions (§3), the request example's own `branchId` field, "Branch Vaults," "Validate Branch," "Branch Isolation," and "Branch cash demand" (in the Forecasting section) are all dropped. "Validate Organization"/"Validate Branch" collapse into the tenant check every controller already performs via `getAccessScope`, the same call already made for Bank Account (Part 13).

## What's genuinely reused from Bank Account (Part 13), and what isn't
This Part mirrors Part 13's proven architecture where the underlying problem is identical, and diverges where cash's own real-world rules differ:
- **Reused in spirit, built separately**: `CashTransactionModel` is a real, append-only ledger with the exact same design discipline as `BankTransactionModel` ("Immutable Cash History") — built as its own collection, not the same one, so "is this money physical cash or bank funds" is always answerable from the record alone. `CashManagementService.applyCashTransaction` mirrors `BankAccountService.applyTransaction`'s exact role as the one internal primitive every real cash movement goes through.
- **Genuinely different**: no encryption/masking (a cash location has no account number to protect); no "available vs. frozen" balance split (no gateway holds on physical cash — dual authorization, see below, is a transfer-execution gate, not a balance-splitting concept); a much simpler lifecycle (see next section).

## Lifecycle interpretation — the location's own lifecycle vs. the recurring count cycle
The spec's own Lifecycle diagram (`Location Created -> Opened -> Operational -> Cash Transactions -> Cash Count -> Balanced`, alternates `Shortage`/`Overage`/`Closed`/`Archived`) conflates two genuinely different things: the location's own durable onboarding lifecycle, and the **recurring daily cash-count cycle** — a location isn't permanently "in shortage" or perpetually "at Cash Count"; a *specific count* reveals a shortage, then it gets resolved. Untangling these:
- **Real location lifecycle** (`cashLocationStatuses`): `Opened -> Closed -> Archived`. "Location Created" and "Opened" are the same real moment (same collapse as Bank Account's own "Created"); "Operational" has no distinguishing trigger from "Opened" either (same collapse as Bank Account's "Active"==\"Operational\"). A location starts directly `Opened` at creation — no separate "open" action exists.
- **The recurring cycle** (`Cash Transactions -> Cash Count -> Balanced/Shortage/Overage`) is modeled as its own separate, repeatable resource — `CashCountModel` — not a status the location itself sits in. `Shortage`/`Overage` become real `varianceType` values on a specific count, resolved independently via `resolveCashCountVariance`, never a lingering location-level state.

## Safe & Vault — Cash Deposit/Withdrawal are just Cash Transfers
"Safe & Vault... Cash Deposit, Cash Withdrawal" is implemented as ordinary `CashTransferModel` operations where one side happens to be a `Safe`/`Vault`-typed location — not separate deposit/withdrawal endpoints duplicating the same real money-movement mechanism. This is the same "reuse one real mechanism instead of inventing a parallel one" call already made repeatedly this session (e.g. Part 12's Refund reusing Part 10's `CustomerCredit`).

## Dual Authorization — a real, distinct second-approval gate
"Dual Control... Dual Authorization... Optional" is genuinely implemented, not just a config flag that does nothing extra: any `CashLocationModel` can be flagged `dualAuthorizationRequired`, and a transfer touching **either side** requires two *different* users' approvals (`hasEnoughApprovals` explicitly rejects the same user approving twice) before it executes. This introduces a real, distinct third transfer status — `"Approved"` — reachable only mid-way through a dual-authorization transfer (the first of two required approvals lands here; a single-authorization transfer's one approval skips straight to `"Completed"`, since there's no meaningful gap between "approved" and "completed" when only one signature was ever needed).

## Petty Cash — the cash side only; full Expense Claims are explicitly Part 16's scope
"Advance Issuance, Expense Claims, Replenishment, Closing" is implemented as the real **cash movement** half of petty cash: `issuePettyCashAdvance` (a real debit, tracked against a specific employee via `PettyCashAdvanceModel`), `settlePettyCashAdvance` (accounts for how an advance was used — only the `returnedAmount` portion creates a new real cash movement, since the `spentAmount` portion already left the location's ledger at issuance), and `replenishPettyCash` (a real credit + journal, funding-source account reused from Part 13's own `bankAdjustmentSuspenseAccountCode` rather than a new near-duplicate config field). **Full Expense Claims — categories, receipt attachment/OCR, approval routing, mileage/per diem — are explicitly Part 16's own scope**, named in this doc's own Part 16 preview; this Part deliberately does not rebuild that as a lightweight parallel version.

## Cash Counts — expected balance is computed, never caller-supplied
`createCashCount`'s `expectedBalance` is always the location's real, live ledger balance (`CashLocationModel.balance`, kept in sync by every `applyCashTransaction` call) — never something the caller supplies. `variance = actualBalance - expectedBalance`; `classifyVariance` returns `"None"` only when `|variance|` is at/under the configured `cashCountVarianceTolerance` (default 0 — exact match required). A genuine variance fires both `CashCountCompleted` and the specific `CashShortageDetected`/`CashOverageDetected` event. `resolveCashCountVariance` posts a real, mandatory-reason correcting entry — Shortage debits `cashShortageExpenseAccountCode` (money is genuinely gone, an expense); Overage credits `cashOverageIncomeAccountCode` (unexplained extra cash, income) — mirroring exactly how Bank Reconciliation's own adjustments work (Part 14), applied to cash instead of bank.

## Cash Forecasting — real, advisory-only AI, same infrastructure as Part 14
"Predict Daily Cash Need... Cash Shortage Risk... Transfer Recommendations. AI advisory only" reuses the exact same `AIModelRouterService` real multi-provider routing Part 14's own AI Matching already established — fed real historical `CashTransactionModel` data (last 90 days, up to 500 movements) across all open locations, never fabricated, and every returned location id is validated against the real candidate set before being returned. Purely informational — `forecastCashNeeds` never creates a transfer itself.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/cash-locations

## Permission
`finance.cash.create`

## Request Example
```json
{
  "name": "Main Branch Cash Drawer",
  "type": "Cash Drawer",
  "currency": "PKR"
}
```

## Business Workflow
Validate Currency -> Approval Workflow -> Create Cash Location -> Audit -> Publish `CashLocationCreated`.

## Validation Rules
`type` is one of the configured `cashLocationTypes`; `currency` is supported; `name` is unique per tenant; `glAccountCode` (if supplied) exists on this tenant's Chart of Accounts; `responsibleEmployeeId` (if supplied) is a real user.

## Domain Events
`CashLocationCreated`

---

# Endpoint Contract: GET /api/v1/cash-locations, /{cashLocationId}, PATCH /{cashLocationId}, POST /{cashLocationId}/close, /archive, GET /{cashLocationId}/transactions

*(`close`/`archive` mirror Bank Account's own; `close` requires a zero balance. `archive` has no domain event named.)*

## Permission
`finance.cash.read` (reads), `finance.cash.manage` (update/close/archive)

## Domain Events
`CashLocationClosed`

---

# Endpoint Contract: POST /api/v1/cash-transfers

## Permission
`finance.cash.create`

## Request Example
```json
{
  "fromLocation": "665f1c2e8b3a4d0012a4e111",
  "toLocation": "665f1c2e8b3a4d0012a4e222",
  "amount": 15000
}
```

## Business Workflow
Validate Source -> Validate Destination -> Validate Available Cash -> Approval Workflow -> Generate Journal -> Update Cash Balances -> Update Ledger -> Audit -> Publish `CashTransferred`.

## Validation Rules
Source and destination are different, both `Opened`, same currency; the amount does not exceed the source's available balance; dual authorization requirement is derived from either location's own flag.

## Domain Events
`CashTransferInitiated`, then `CashTransferred` once fully approved

---

# Endpoint Contract: GET /api/v1/cash-transfers, /{transferId}, POST /{transferId}/approve, /reject, /cancel

*(`reject`/`cancel` have no domain events named. `approve` may need to be called twice by two different users under dual authorization — see "Dual Authorization" above.)*

## Permission
`finance.cash.read` (reads), `finance.cash.approve` (approve/reject), `finance.cash.create` (cancel)

---

# Endpoint Contract: POST /api/v1/cash-locations/{cashLocationId}/counts

*(Gap-fill endpoint path — "Cash Counts" names no distinct POST contract in the spec's own Endpoint Contracts, only its own descriptive section; the real `CashCountCompleted`/`CashShortageDetected`/`CashOverageDetected` domain events needed one.)*

## Permission
`finance.cash.create`

## Domain Events
`CashCountCompleted`, and `CashShortageDetected`/`CashOverageDetected` when a real variance is found

---

# Endpoint Contract: GET /api/v1/cash-counts, /{countId}, POST /{countId}/resolve

*(`resolve` is a gap-fill — no `CashCountResolved` event is named, so none is invented; `notes` is mandatory, matching the spec's own "Reason mandatory" rule for Cash Adjustments.)*

## Permission
`finance.cash.read` (reads), `finance.cash.approve` (resolve)

---

# Endpoint Contract: POST /api/v1/cash-locations/{cashLocationId}/petty-cash/advances

## Permission
`finance.cash.create`

## Domain Events
`PettyCashIssued`

---

# Endpoint Contract: GET /api/v1/petty-cash/advances, /{advanceId}, POST /{advanceId}/settle, POST /api/v1/cash-locations/{cashLocationId}/petty-cash/replenish

*(`settle` has no domain event named. `replenish` fires the named `PettyCashReplenished`.)*

## Permission
`finance.cash.read` (reads), `finance.cash.manage` (settle/replenish)

## Domain Events
`PettyCashReplenished`

---

# Endpoint Contract: GET /api/v1/cash-management/forecast

*(Gap-fill — see "Cash Forecasting" above.)*

## Permission
`finance.cash.read`

---

# Domain Events (Part 15 Summary)

`CashLocationCreated`, `CashTransferInitiated`, `CashTransferred`, `CashCountCompleted`, `CashShortageDetected`, `CashOverageDetected`, `PettyCashIssued`, `PettyCashReplenished`, `CashLocationClosed`.

## Deferred / not built this pass
- **Full Expense Claims (categories, receipts/OCR, approval routing, mileage/per diem)** — explicitly Part 16's own scope; this Part only tracks the real cash movement side of a petty cash advance and its settlement.
- **Smart safes / cash recyclers / ATM device integrations** — named only in this Part's own "Principal Software Architect Improvement" as future integrations; no such hardware/API integration exists or was asked for.
- **Cash Operations Platform / Enterprise Liquidity Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Cash Platform" (standalone Location/Balance/Count/Transfer/Variance/Forecast engines) and, above that, a "Liquidity Platform" coordinating Banking + Cash + Treasury. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `CashManagementService` already fills the real role directly, and Treasury-level liquidity optimization/risk/investment concerns have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 16 — Enterprise Expense Management APIs

## Overview
"The expense is not the payment. The reimbursement is the financial event." This distinction is structural, not just narrative: `ExpenseModel.paymentMethod` (how the employee originally paid — Personal Cash, Personal Card, Corporate Card, ...) and `ExpenseModel.reimbursement.method` (how the company pays them back — Bank Transfer, Cash, Petty Cash, Accounts Payable) are two deliberately separate fields, set at two different points in the lifecycle, dispatching to two different real subsystems.

## Tenant-only — the spec's branch language dropped entirely
Per the standing master instructions (§3), the request/validation-rule "Branch Match" and the `branch` query param are dropped. No branch dimension exists anywhere in this Part's models, service, or Joi schemas.

## Real OCR — not the Visa domain's own honest stub
"OCR Extraction"/"OCR Integration" (AI Coding Rule)/`OCRCompleted` (named event) are implemented for real, using `tesseract.js` (images) and the already-installed `pdf-parse` (text-based PDFs) — genuinely extracted text and heuristically parsed fields (amount, date, vendor), not fabricated. This is a deliberate departure from the pattern this codebase already has for OCR: `services/DocumentVerificationService.js` (the Visa domain's own document verification) honestly queues OCR to an "external processor" that doesn't exist and never fabricates a result — a correct, honest stance for THAT module, since no live OCR provider was ever configured for it. Part 16 had the option to actually build one instead of repeating that stub, and took it. A real bug was caught and fixed during development: the amount-extraction regex's naive `total` keyword match was matching inside `"Subtotal: 100.00"` before ever reaching the real `"Total: 115.00"` line — fixed with a negative lookbehind (`(?<!sub)total`), and locked in as a permanent regression test (`tests/expenseOcrService.test.js`).

## Lifecycle interpretation — the durable status vs. the real approval-progress array
The spec's own Lifecycle diagram draws `Draft -> Submitted -> Manager Review -> Finance Review -> Approved -> Reimbursed -> Closed`. Per this session's now-consistent rule (a Business Workflow paragraph describes the whole eventual pipeline, not one atomic call; the Lifecycle diagram's own states are the real contract — but even the diagram here conflates two different things), "Manager Review" and "Finance Review" collapse into one resting status, `"Under Review"` — which of those levels is actually still pending is tracked by `requiredApprovalLevels`/`approvals[]` on the expense itself, the exact same ordered-multi-approval array design already proven by Part 15's `CashTransferModel` (dual authorization), now extended from "any N distinct approvers" to "N approvers at specific, sequential named levels."

## Real amount-based multi-level approval — finally buildable
Every earlier module's own "Amount Based"/"Multi-level Approval" spec language was honestly left as a single on/off gate, because no concrete thresholds or level structure were ever given to build a real policy against. This spec is different: it draws two literal sequential review steps (Manager, then Finance) in its own Lifecycle diagram, giving real structure. `computeRequiredApprovalLevels` builds on that: Manager review is always required; `Finance`/`CFO` are added once the amount reaches `expenseApprovalThresholdFinance`/`expenseApprovalThresholdCFO` (0/unset = that tier never required). `approveExpense` always records the approval at the next sequential pending level and only fires the named `ExpenseApproved` once every required level is done — a partial approval (e.g. Manager done, Finance still pending) stays `"Under Review"` with no event of its own, matching the Domain Events list, which names only one final `ExpenseApproved`, not one per level. Still not the full CFO/Department-Head role-to-person mapping the spec lists — this codebase's RBAC has no org-hierarchy model to know who someone's actual manager is, so `finance.expense.approve` gates who may record ANY level's approval, the identical simplification already made for Cash Transfer's own dual authorization (Part 15).

## Real Budget Validation — Department -> Project -> Cost Center cascade
"Budget Validation: Department Budget -> Project Budget -> Cost Center Budget -> Approval Decision" is implemented as a real, minimal `ExpenseBudgetModel` (allocated vs. live consumed amount, per scope+period) and a genuine cascade: `submitExpense` checks the expense's Department budget first, then Project, then Cost Center, using the FIRST one found (not all three simultaneously) — matching the spec's own presented fallback order. No budget configured for any scope = no constraint (the same "unconfigured = permissive" convention already used for AR's own credit limit). `expenseBudgetEnforcement` (`Block`/`Warn`, default `Warn`) makes the spec's own "Budget rules configurable" real: `Block` hard-stops submission over budget; `Warn` allows it through, flags `budgetCheck.exceeded`, and fires `BudgetExceeded` for a human to see. Budget consumption is recorded at **approval** (not submission) — a claim that gets rejected or returned never permanently ties up budget it didn't end up using.

## Policy Engine — hard-blocking, unlike Budget's configurable softness
"Policy Valid" sits among the spec's own hard `Validation Rules` (alongside Employee Exists, Budget Available, Financial Period Open — phrased as things that must be true), so `checkPolicyViolations` (per-category amount caps, receipt-required-above-threshold) genuinely blocks `submitExpense` when violated, a deliberate contrast with Budget's own configurable enforcement.

## Reimbursement — real dispatch to three already-built subsystems, two honestly excluded
"Reimbursement... Supports: Payroll, Bank Transfer, Cash, Petty Cash, Wallet Credit, Accounts Payable." Three are real, dispatching to already-proven primitives:
- **Bank Transfer** -> `BankAccountService.applyTransaction` (Part 13) — a real Debit against a company bank account.
- **Cash / Petty Cash** -> `CashManagementService.applyCashTransaction` (Part 15) — a real Debit against a cash location.
- **Accounts Payable** -> `AccountsPayableService.createPayable` (Part 6) directly, reusing that service's own existing journal-posting logic entirely rather than duplicating it — requires the employee to already exist as a real `VendorModel` record (a genuine real-world pattern for contractor reimbursement, not assumed away).

**"Payroll" and "Wallet Credit" are deliberately excluded from `reimbursementMethods`** — no Payroll module and no employee-wallet concept exist anywhere in this codebase, the identical "don't list an unimplemented integration as if it were real" discipline Part 14 already applied to excluding "Open Banking API" from its own supported-formats list.

For Bank Transfer/Cash/Petty Cash — which don't post their own journal the way `AccountsPayableService.createPayable` does — `reimburseExpense` posts one directly: Debit `expenseReimbursementExpenseAccountCode` / Credit the paying account's own `glAccountCode`, same "skip posting until configured" fallback as every other optional account code in this module.

## Corporate Cards — real data fields, no card-network integration
"Corporate Cards... Card reconciliation supported" is captured as real structured data (`paymentMethod`, `corporateCard.{cardType, last4, cardholderName}`) on the expense itself — genuinely useful for reporting and matching against a statement import. No live card-network API integration exists or was asked for with real credentials; "card reconciliation" against an actual card-network feed is honestly deferred, the same category of deferral as Part 14's own excluded Open Banking API.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/expenses

## Permission
`finance.expense.create`

## Request Example
```json
{
  "employeeId": "665f1c2e8b3a4d0012a4e111",
  "category": "Travel",
  "amount": 350,
  "currency": "USD",
  "expenseDate": "2027-04-15",
  "description": "Hotel Accommodation"
}
```

## Business Workflow
Validate Employee -> Compute Amount (direct, or from Per Diem/Mileage) -> Generate Expense Number -> Publish `ExpenseCreated`. Policy/Budget/Approval Workflow happen at `submit`, not here — see "Lifecycle interpretation" above.

## Validation Rules
`category` is one of the configured `expenseCategories`; `currency` is supported; the employee exists; `department` (if supplied) exists.

## Domain Events
`ExpenseCreated`

---

# Endpoint Contract: GET /api/v1/expenses, /{expenseId}, PATCH /{expenseId}

*(`PATCH` gap-fill, Draft/Returned only.)*

## Permission
`finance.expense.read` (reads), `finance.expense.create` (update)

---

# Endpoint Contract: POST /api/v1/expenses/{expenseId}/receipts, POST /{attachmentId}/verify

*(`verify` gap-fill for the named `ReceiptVerified` event — only fires it for the "Verified" outcome, not "Duplicate"/"Rejected".)*

## Permission
`finance.expense.create` (upload), `finance.expense.approve` (verify)

## Domain Events
`OCRCompleted` (when OCR runs and completes), `ReceiptVerified`

---

# Endpoint Contract: POST /api/v1/expenses/{expenseId}/submit

## Permission
`finance.expense.create`

## Business Workflow
Validate Policy -> Validate Budget -> Compute Required Approval Levels -> Publish `ExpenseSubmitted`.

## Validation Rules
Financial period open; no policy violations; budget not exceeded (or `expenseBudgetEnforcement` is `Warn`).

## Domain Events
`ExpenseSubmitted`, `BudgetExceeded` (when over budget and enforcement is `Warn`)

---

# Endpoint Contract: POST /api/v1/expenses/{expenseId}/approve, /reject, /return, /cancel

*(`return`/`cancel` are gap-fill — no domain events named for either.)*

## Permission
`finance.expense.approve` (approve/reject/return), `finance.expense.create` (cancel)

## Domain Events
`ExpenseApproved` (only once every required level has approved), `ExpenseRejected`

---

# Endpoint Contract: POST /api/v1/expenses/{expenseId}/reimburse

## Permission
`finance.expense.manage`

## Domain Events
`ExpenseReimbursed`

---

# Endpoint Contract: POST /api/v1/expenses/{expenseId}/close

## Permission
`finance.expense.manage`

## Domain Events
`ExpenseClosed`

---

# Endpoint Contract: POST /api/v1/expense-budgets, GET /expense-budgets, /{budgetId}

*(Gap-fill — real minimal budget CRUD, the only way to make "Budget Validation" actually testable/usable.)*

## Permission
`finance.expense.manage` (create), `finance.expense.read` (reads)

---

# Domain Events (Part 16 Summary)

`ExpenseCreated`, `ExpenseSubmitted`, `ExpenseApproved`, `ExpenseRejected`, `ExpenseReimbursed`, `BudgetExceeded`, `ReceiptVerified`, `OCRCompleted`, `ExpenseClosed`.

## Deferred / not built this pass
- **Payroll and Wallet Credit reimbursement** — no Payroll module or employee-wallet concept exists anywhere in this codebase; both excluded from `reimbursementMethods` honestly rather than listed as if implemented.
- **Live corporate-card-network reconciliation** — real structured card data is captured; matching it against an actual card-network feed would need a real integration this codebase doesn't have.
- **Geocoding-based automatic mileage distance calculation** — "Distance Calculation" is implemented as caller-supplied distance × a configured per-vehicle rate; auto-computing distance between two addresses would need a real Maps/geocoding API key, not configured anywhere in this codebase.
- **Enterprise Expense Platform / Financial Policy Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Expense Platform" (standalone Policy/Budget/OCR/Approval/Reimbursement engines) and, above that, a "Financial Policy Platform" shared across Expense/Procurement/Travel/Payroll/Purchasing. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `ExpenseService` already fills the real role directly, and Procurement/Payroll/Purchasing have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 17 — Enterprise Vendor Payments APIs

## Overview
"Payment Engine moves money. Vendor Payment Platform decides which vendor, which invoices, which bank account, which date, which approval, which payment file." This distinction is architecturally real in this implementation, not just narrative: `VendorPaymentService.executeVendorPayment` **never moves money itself** — it delegates entirely to `PaymentService.createPayment` (Part 7, the real Payment Engine) and `AccountsPayableService.allocatePayment` (Part 6, the real AP settlement), and the real bank-account debit happens automatically through Part 13's own `PaymentCaptured` event listener with zero new money-movement code required. Part 17 is the orchestration layer this doc's own Part 17 "Next" note (written at the end of Part 16) predicted it would be: a scheduling/batching/proposal/approval layer on top of what already existed, not a rebuild.

## A note on the Progress checklist
"Vendor Payments" was marked `[x]` early in this doc (Part 7) with a note that it was "superseded" — Part 7's own Payment Engine treats vendor payments as a `paymentType` on one unified engine, and at the time no dedicated planning/approval/scheduling layer existed above it. That note is now outdated: this Part builds the real, distinct orchestration layer the spec calls for, so the checklist item is updated here to reflect Part 17 as a genuine, separate module — not a re-litigation of Part 7's own correct architectural call (the Payment Engine still does the actual money movement; Part 17 sits above it, exactly as this Part's own opening framing describes).

## Tenant-only — the spec's branch language dropped entirely
Per the standing master instructions (§3), the request/validation-rule "Branch Match" and the `branch` query param are dropped. No branch dimension exists anywhere in this Part's models, service, or Joi schemas.

## Extending existing models instead of duplicating
Two already-shipped models had exactly the gap Part 17 needed, and both were extended rather than replaced:
- **`VendorModel.bankAccounts[]`** (Part 6) — that model's own original doc comment already named this as future scope ("not the eventual Procurement module's richer vendor profile... bank details"); "Vendor Bank Accounts... Multiple Accounts, Primary Account, IBAN, SWIFT/BIC" is now real.
- **`BankAccountModel.routingNumber`** (Part 13) — needed for real NACHA/ACH generation, which identifies a bank by US routing number rather than IBAN/SWIFT; a small, safe, additive field next to the `iban`/`swiftCode` it already had.

## Real IBAN/SWIFT validation — not just a format regex
"Validation configurable" is implemented for real: `isValidIban` performs the actual MOD-97-10 checksum algorithm (not just a shape check), verified during development against real, well-known test IBANs (GB/DE/FR) and a deliberately tampered one to confirm it actually rejects bad checksums. `isValidSwiftBic` checks the real 8-or-11-character BIC format.

## Real payment file generation — the mirror-opposite of Part 14's parsers
"Payment Files... ACH, SEPA, ISO 20022, SWIFT MT, CSV — Generated automatically" is implemented with four real generators (`services/paymentFileGenerators/`, `SEPA` and `ISO 20022` sharing one real pain.001 implementation since SEPA Credit Transfer IS a specific ISO 20022 usage, not a separate format):
- **ACH** — a real NACHA fixed-width file (File Header, Batch Header, Entry Detail per payment, Batch Control, File Control), every record verified during development to be exactly the required 94 characters, with real routing-number/account-number placement and real hash/total-amount control fields computed from the actual payment data. Scoped to a single batch per file — a legitimate, documented choice, not a shortcut that produces an invalid file for what it does cover.
- **SEPA / ISO 20022** — real `pain.001.001.03` XML via `fast-xml-parser`'s `XMLBuilder` (the same package Part 14's statement parsing already installed, now used in its builder direction).
- **SWIFT MT** — real MT103 (Single Customer Credit Transfer) blocks, one per payment (MT103 is inherently a single-transfer message, not a batch format), with the real `:20:`/`:23B:`/`:32A:`/`:50K:`/`:59:`/`:70:`/`:71A:` tag grammar.
- **CSV** — a plain real export, the simplest of the five.

This is the honest mirror-image of Part 14's own real statement PARSERS (reading a bank's file) — Part 17 GENERATES one instead. The genuinely unbuilt half, consistent with every prior Part's own external-integration discipline, is submitting that file to a real bank host-to-host API — no bank API credentials exist anywhere in this codebase, the same category of deferral as Part 14's excluded Open Banking API.

## Lifecycle interpretation
Real resting states: `Proposed -> Approved -> Scheduled -> Executing -> Completed`, alternates `Rejected`/`Cancelled`/`Failed`/`On Hold`. "Pending Approval" (spec's own Lifecycle diagram) is not a separate resting status — a freshly proposed payment simply sits in `"Proposed"` awaiting approval, the same "no distinguishing trigger between two adjacent diagram states" collapse already applied identically to Bank Reconciliation's "Statement Imported"/"Auto Matching" and Cash Management's own transient states this session.

## Real "Dual Approval" — reusing Part 15's exact proven design
"Dual Approval" (Security section) is genuinely implemented, not a relabeled single gate: at/above `vendorPaymentDualApprovalThreshold`, two *different* users must approve (`hasEnoughApprovals` rejects the same user approving twice) — the identical ordered/count-based multi-approval array design Part 15's `CashTransferModel` already proved, reused directly rather than reinvented.

## Real cash-availability check before execution
"Payment Scheduling... Cash Availability" is a real, enforced check — `executeVendorPayment` verifies the paying `BankAccountModel`'s own live `balances.available` covers the total before calling the Payment Engine, not an advisory note. "Business Day" rolling (Sat/Sun -> next Monday) is real; "Holiday Rules" is honestly not implemented — no holiday-calendar data exists anywhere in this codebase.

## Advance Payments — reusing Part 6's own existing auto-linking, unchanged
"Advance Payments... Linked automatically to future invoices" required no new linking code at all: `createVendorAdvance` issues a real payment and calls `VendorCreditService.createCredit` directly — the exact same `VendorCreditModel` record `AccountsPayableService.createPayable`'s own `consumeAvailableCredits` call (built in Part 6, long before this Part existed) already knows how to apply automatically the next time a payable is created for that vendor. Part 17 only had to produce the credit; the "automatic" part was already real infrastructure.

## Discount Optimization / AI Payment Recommendation — real, advisory only
`suggestPaymentTiming` is a genuine LLM call through the same `AIModelRouterService` this session's other AI features already use (Bank Reconciliation's AI Matching, Cash Management's Cash Forecasting) — fed real open payables and real bank balances, every recommended payable id re-validated against the real candidate set, advisory only, never auto-scheduling anything. Formal "Early Payment Discount"/"Dynamic Discount" terms are honestly NOT implemented — no contractual discount-terms field exists anywhere on `VendorModel` or `AccountsPayableModel` (e.g. "2/10 net 30"); fabricating a discount calculation with no real underlying terms data would misrepresent what this module actually knows about a vendor's contract.

## Endpoint Contracts

# Endpoint Contract: POST /api/v1/vendors/{vendorId}/bank-accounts, GET, POST /{bankAccountRecordId}/set-primary

*(Gap-fill — real endpoints for the real `VendorModel.bankAccounts[]` extension above.)*

## Permission
`finance.vendorpayment.read` (list), `finance.vendorpayment.manage` (add/set-primary)

---

# Endpoint Contract: POST /api/v1/vendor-payments

## Permission
`finance.vendorpayment.create`

## Request Example
```json
{
  "vendorId": "665f1c2e8b3a4d0012a4e111",
  "invoiceIds": ["665f1c2e8b3a4d0012a4e222", "665f1c2e8b3a4d0012a4e333"],
  "paymentDate": "2027-04-30",
  "bankAccountId": "665f1c2e8b3a4d0012a4e444"
}
```

## Business Workflow
Validate Vendor -> Validate Outstanding Payables -> Validate Bank Account -> Create Payment Proposal -> Approval Workflow -> Publish `VendorPaymentProposed`.

## Validation Rules
Vendor exists and is Active; every invoice belongs to this vendor and is open (`isPayableEligibleForPayment`, reused from Part 6); currency matches across payables/bank account; an optional per-line `amounts` override supports "Partial Payments" (defaults to each payable's full outstanding balance).

## Domain Events
`VendorPaymentProposed`, `VendorPaymentApproved` (only when auto-approved)

---

# Endpoint Contract: GET /api/v1/vendor-payments, /{vendorPaymentId}, POST /approve, /reject, /cancel, /hold, /release-hold, /schedule, /execute

## Permission
`finance.vendorpayment.read` (reads), `finance.vendorpayment.approve` (approve/reject), `finance.vendorpayment.create` (cancel), `finance.vendorpayment.manage` (hold/release-hold/schedule/execute)

## Business Workflow (execute)
Validate Approval -> Reserve Funds (real cash-availability check) -> Call Payment Engine -> Receive Gateway Result -> Update AP -> Generate Journal/Ledger (both inside the delegated services' own logic) -> Audit -> Publish `VendorPaymentCompleted`.

## Domain Events
`VendorPaymentApproved`, `VendorPaymentScheduled`, `VendorPaymentExecuted`, `VendorPaymentCompleted`, `VendorPaymentFailed`

---

# Endpoint Contract: POST /api/v1/vendor-payments/file

*(Gap-fill — real payment file generation for one or more vendor payments; see "Real payment file generation" above.)*

## Permission
`finance.vendorpayment.manage`

---

# Endpoint Contract: POST /api/v1/payment-batches, GET, GET /{batchId}, POST /{batchId}/execute

*(`execute` gap-fill — executes every still-Scheduled payment in the batch, tracking real per-payment outcomes rather than one atomic all-or-nothing unit.)*

## Permission
`finance.vendorpayment.read` (reads), `finance.vendorpayment.manage` (create/execute)

## Domain Events
`PaymentBatchGenerated`

---

# Endpoint Contract: POST /api/v1/vendor-payments/advances

## Permission
`finance.vendorpayment.create`

## Domain Events
`VendorAdvanceCreated`

---

# Endpoint Contract: GET /api/v1/vendor-payments/suggest-timing

*(Gap-fill — see "Discount Optimization / AI Payment Recommendation" above.)*

## Permission
`finance.vendorpayment.read`

---

# Domain Events (Part 17 Summary)

`VendorPaymentProposed`, `VendorPaymentApproved`, `VendorPaymentScheduled`, `VendorPaymentExecuted`, `VendorPaymentCompleted`, `VendorPaymentFailed`, `VendorAdvanceCreated`, `PaymentBatchGenerated`.

## Deferred / not built this pass
- **Real bank host-to-host payment file submission** — a generated ACH/SEPA/SWIFT file is real and correct; actually transmitting it to a bank's own API would need real bank credentials this codebase doesn't have.
- **Holiday-calendar-aware scheduling** — only real weekend rolling is implemented; no holiday calendar data exists anywhere in this codebase.
- **Formal early-payment/dynamic discount terms** — no contractual discount-terms field exists on Vendor or Payable; the AI timing advisory works from real due dates and cash position only, not a fabricated discount calculation.
- **Vendor Payment Platform / Payment Orchestration Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Vendor Payment Platform" (standalone Proposal/Scheduler/Batch/File-Generator/Approval/Cash-Availability/Discount engines) and, above that, a "Payment Orchestration Platform" coordinating Vendor Payments/Customer Collections/Payroll/Refunds/Treasury. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `VendorPaymentService` already fills the real role directly, and Payroll/Treasury have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 18 — Enterprise Customer Payments APIs

## Overview
"The Customer Collection Platform manages the collection strategy. The Payment Engine performs the actual payment." Part 18 is the mirror-image of Part 17 on the AR side: `CustomerCollectionService` decides which customer, which invoices, which due date, whether an installment plan or a payment link applies, and when a reminder is due — it never moves money itself. Every actual capture goes through the already-real `PaymentService.createPayment` (Part 7) and every AR balance update goes through the already-real `AccountsReceivableService.allocatePayment` (Part 5), the literal "Payment Engine executes, Collection Platform orchestrates" split this Part's own spec opens with.

Tenant-only per the standing master instructions — the spec's own "Branch Match"/"Branch Isolation"/`branch` query param are dropped everywhere in this Part; there is no branch dimension anywhere in this codebase.

## New models
- **`CustomerCollectionModel`** (`customer_collection`) — the real collection/decision record: `lineItems[]` (which receivables, how much of each has been collected so far), `installments[]`, `payments[]` (every real Payment Engine capture this collection has gone through — supports true partial payments across multiple calls), `paymentLink{}`, `lateFee{}`, and the usual timeline/audit fields.
- **`CollectionReminderModel`** (`collection_reminder`) — a durable, per-send log of every reminder actually attempted, `Sent`/`Failed`/`NotConfigured` per `services/delivery/`'s own real contract (Part 8). `collectionId` is nullable — see "Closing the NotificationRequested gap" below for why.

## Real resting states only
`customerCollectionStatuses` = `Requested, Partially Collected, Collected, Overdue, Payment Failed, Disputed, Written Off, Cancelled, Closed`. The spec's own Lifecycle diagram lists "Payment Requested -> Reminder Sent -> Customer Pays -> Payment Verified -> Receipt Generated -> Accounts Receivable Updated -> Closed" as one synchronous pipeline description, not eight distinct resting states — "Reminder Sent"/"Payment Verified"/"Receipt Generated"/"Accounts Receivable Updated" are all real side effects of a single `collect` call (a reminder log entry, the Payment Engine's own verified capture, Part 8's own receipt generation being trivially callable against any Captured/Allocated payment, and a real `AccountsReceivableService.allocatePayment` call respectively) rather than separate states a caller transitions through one at a time. `Collected` and `Closed` ARE kept as two distinct real states, unlike other collapsed pairs this session — this codebase already has an identical precedent (Invoice's own `Paid` -> `Closed` split, Part 9), and `closeCollection` is a real, separately-triggered administrative action here too, not an automatic side effect of full collection.

## Endpoint Contract: POST /api/v1/customer-payments
Validate Customer -> Validate Outstanding Invoices -> Create Collection Request -> Generate Payment Link (Optional) -> Publish `CustomerPaymentRequested`.

### Request
```json
{
  "customerId": "...",
  "invoiceIds": ["...", "..."],
  "paymentDueDate": "2027-05-15",
  "preferredMethod": "Bank Transfer",
  "generatePaymentLink": false
}
```

### Validation Rules
Customer exists; every invoice belongs to this customer and is open (not `Paid`/`Settled`/`Written Off`/`Cancelled`, outstanding balance > 0); currency matches across every line item.

### Permission
`finance.customercollection.create`

### Domain Events
`CustomerPaymentRequested`, `PaymentLinkGenerated` (only when `generatePaymentLink: true`)

---

## Endpoint Contract: GET /api/v1/customer-payments, GET /{collectionId}, GET /analytics

### Permission
`finance.customercollection.read`

---

## Endpoint Contract: POST /api/v1/customer-payments/{collectionId}/collect
Validate Collection -> Generate Payment Request -> Call Payment Engine -> Receive Payment Result -> Update AR -> Audit -> Publish `CustomerPaymentCollected`. Never moves money itself — delegates entirely to `PaymentService.createPayment` and `AccountsReceivableService.allocatePayment`.

### Request
```json
{ "amount": 500.00, "paymentMethod": "Bank Transfer", "installmentNumber": 1 }
```
`amount` defaults to the collection's full remaining balance when omitted — the real "Partial Payments" support: any amount up to (but not exceeding) the remaining balance splits across outstanding line items FIFO, each portion allocated through the real AR handoff independently, with per-line allocation warnings recorded (never silently dropped) exactly like Part 17's own `executeVendorPayment`. `installmentNumber` is optional — when supplied and the collection has an installment plan, that installment's own `paidAmount`/`status` is updated too and `InstallmentPaid` fires once it's fully paid.

### Permission
`finance.customercollection.manage`

### Domain Events
`CustomerPaymentCollected`, `InstallmentPaid` (only when `installmentNumber` fully pays that line)

---

## Endpoint Contract: POST /api/v1/customer-payments/{collectionId}/installments
"Installment Plans... Weekly, Monthly, Quarterly, Custom Schedule." Even splits use the same "remainder lands on the last line" rounding discipline used everywhere else money gets divided in this codebase, so the parts always sum to exactly the whole; `frequency: "Custom"` instead takes the caller's own `customSchedule` array and validates it sums to the scheduled total rather than trusting it blindly. Schedules against the collection's own remaining balance, not necessarily its original total, so a plan can be created after a partial payment already landed.

### Permission
`finance.customercollection.manage`

### Domain Events
`InstallmentCreated`

---

## Endpoint Contract: POST /api/v1/customer-payments/{collectionId}/payment-link, GET /api/v1/customer-payments/pay/{token}
"Payment Links... One-Time Link, Expiring Link, QR Payment... Gateway independent." Reuses `ReceiptQrService`'s own real `crypto.randomBytes(24)` token and `qrcode`-package QR generation directly (Part 8) — not a parallel implementation. The public `GET /pay/{token}` route is registered before `router.use(authenticateAccessToken)` in `routes/FinanceRoutes.js` (the same public-token-as-access-control convention as Part 8's own `/receipts/verify/:token`), and returns the same minimal, safe subset Part 8's `verifyByToken` does — no tenantId or internal ids leaked.

**Deliberately GET-only.** This codebase has no real customer-facing authentication or hosted-checkout surface, so an unauthenticated `POST`-pay-via-token endpoint would be a genuine "anyone holding the link can move money" hole. Actually collecting payment always goes through the authenticated `POST .../collect` endpoint — same "real vs. honestly deferred" boundary as every other Part's excluded external-integration pieces (a real hosted-checkout UI/gateway-hosted-page integration is deferred, not faked).

### Permission
`finance.customercollection.manage` (generate); the `GET /pay/{token}` view itself is public

### Domain Events
`PaymentLinkGenerated`

---

## Endpoint Contract: POST /api/v1/customer-payments/{collectionId}/send-reminder, GET /{collectionId}/reminders

### Closing the `NotificationRequested` gap
`services/receivableOverdueScheduler.js` (Part 5) has published `NotificationRequested` for every AR collection-stage escalation since that scheduler shipped — grepped across the whole codebase before writing this Part, confirmed zero listeners anywhere ever consumed it. `CustomerCollectionService.initEventListeners()` (registered in `server.js` alongside every other Part's own listener) now subscribes to it for real: it resolves the affected customer, sends through the already-real `services/delivery/` adapters (Part 8 — Email/SMS/WhatsApp/Webhook), and records every attempt — `Sent`, `Failed`, or `NotConfigured` — in `CollectionReminderModel`, without touching `receivableOverdueScheduler.js` at all. This fires for every escalating receivable, whether or not it was ever pulled into a formal Customer Payments collection request (`collectionId` on the reminder is nullable for exactly this reason) — a strictly larger fix than only wiring the Collection Platform's own manual reminders. AR's two highest collection stages (`Phone Call`, `Management Escalation`) have no real adapter anywhere in this codebase; those fall back to Email (still genuinely delivered) rather than being silently dropped.

"Late Fee" (Dunning Process) is real too, applied at most once per collection (`lateFee.applied`) the first time the configured stage is reached, off the same escalation listener — 0% by default (disabled). No ledger posting for it: no late-fee income account was named anywhere in this Part's spec, so it's tracked on the collection record only, the same "deferred, honestly documented" treatment as Part 17's own excluded Holiday Rules.

`sendReminder` is the manual-trigger counterpart — same real adapters, same log.

### Permission
`finance.customercollection.manage` (send), `finance.customercollection.read` (list)

### Domain Events
`ReminderSent` (only when a channel genuinely confirms `Sent`)

---

## Endpoint Contract: POST /api/v1/customer-payments/{collectionId}/dispute, /write-off, /cancel, /close

`write-off` writes off every still-outstanding line item's underlying receivable through the real `AccountsReceivableService.writeOff` (Part 5) — it never adjusts a balance directly. No Domain Event is published for Dispute/Write-Off/Cancel (none is named in this Part's own Domain Events list) — `CollectionClosed` is the one exception, since it is named.

### Permission
`finance.customercollection.manage` (dispute/cancel/close), `finance.customercollection.approve` (write-off)

### Domain Events
`CollectionClosed`

---

## Endpoint Contract: POST /api/v1/customer-payments/deposits
"Advance Customer Deposits... Booking Deposit, Visa Deposit, Project Deposit, Subscription Deposit — automatically allocated to future invoices." Reuses `CustomerCreditService.createCredit` directly (Part 10) — the exact same auto-linking `AccountsReceivableService.createReceivable` already consumes via `consumeAvailableCredits`, mirroring Part 17's own `createVendorAdvance` reuse of `VendorCreditService` on the AP side. This Part's own Domain Events list does not name a dedicated deposit event (unlike Part 17's `VendorAdvanceCreated`), so this reuses `CustomerPaymentCollected` with an `isDeposit: true` flag rather than inventing a new event name.

### Permission
`finance.customercollection.create`

### Domain Events
`CustomerPaymentCollected` (`isDeposit: true`)

---

## Collection Analytics
"Collection Rate, Average Days to Collect, Overdue Amount, Recovery Rate, Reminder Effectiveness, Cash Flow Forecast." Every metric but the forecast is a real MongoDB aggregation against `CustomerCollectionModel`/`CollectionReminderModel` (collection rate = collected/total; average days to collect = mean of `collectedAt - requestedAt`; recovery rate = collections that ever went Overdue and later reached Collected/Closed, over all collections that ever went Overdue; reminder effectiveness = collections with a `Sent` reminder that later reached Collected/Closed, over all collections with a `Sent` reminder). Cash flow forecast is a real advisory LLM call via `AIModelRouterService`, fed real open collections (remaining amount, currency, due date, status) — mirrors Cash Management's own Cash Forecasting (Part 15) and Vendor Payment's `suggestPaymentTiming` (Part 17) exactly: advisory only, never auto-schedules anything.

## Overdue detection
`services/customerCollectionScheduler.js` mirrors `receivableOverdueScheduler.js`'s own real `node-cron` pattern — a Collection has its own `paymentDueDate`, which can diverge from its underlying invoices' own due dates once a collection request negotiates a different one, so it needs its own overdue pass rather than assuming AR's own overdue state implies this collection is overdue too.

## Domain Events (Part 18 Summary)
`CustomerPaymentRequested`, `ReminderSent`, `PaymentLinkGenerated`, `CustomerPaymentCollected`, `InstallmentCreated`, `InstallmentPaid`, `CollectionOverdue`, `CollectionClosed`.

## Deferred / not built this pass
- **Real hosted-checkout / customer self-serve payment UI** — the payment link's public view (`GET /pay/{token}`) is real and safe; an actual customer-facing page that collects card details would need a real hosted-checkout integration (e.g. a gateway's own hosted page) this codebase doesn't have credentials for. Collecting still requires the authenticated `POST .../collect` endpoint.
- **Push Notification / Customer Portal reminder channels** — no real surface for either exists anywhere in this codebase (same as Part 8's own receipt delivery); both are still accepted and recorded as `NotConfigured`, never silently dropped.
- **Ledger posting for Late Fees** — tracked on the collection record only; no late-fee income account was named in this Part's spec to post against.
- **Customer Collection Platform / Enterprise Revenue Collection Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Customer Collection Platform" (Collection Manager/Reminder Engine/Dunning Engine/Installment Manager/Payment Link Generator/Collection Analytics Engine/Audit Engine/Payment Engine Adapter/Event Publisher) and, above that, an "Enterprise Revenue Collection Platform" spanning Customer/Subscription/POS/E-commerce/Donation Collection Platforms. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `CustomerCollectionService` already fills the real role directly, and Subscription/POS/E-commerce/Donation collection have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 19 — Enterprise Multi-Currency & Foreign Exchange APIs

## Overview
"One business transaction can involve multiple currencies simultaneously. The ERP must preserve all of them correctly for accounting and reporting." Part 19 is the ERP's shared Conversion/Revaluation Engine — every other Finance module can call into it (`CurrencyService.convert`), but nothing about how AR/AP/BankAccount/Payment already store their own `currency` field needed to change to get real value from it: revaluation reads their live balances directly, with zero schema changes to any of Parts 5/6/7/13.

## A real bug fixed first
Before writing any new code, analysis (per the standing master instructions' Step 1 — "scan the entire project... never assume") surfaced a real, pre-existing correctness bug squarely in this Part's own domain: `utils/financeConfig.js` re-exported `bookingConfig.supportedCurrencies` (which defaults to **lowercase** codes — `'usd'`, `'sar'`, ... — Booking's own convention, see `BookingController.js`'s own `.toLowerCase()` comparisons) unmodified. Every Finance document, however, stores/compares currency as **uppercase** ISO 4217 (`"USD"` — confirmed via `services/paymentFileGenerators`, the IBAN tests, and every Finance model's own `currency` field). Left as-is, this silently broke real API calls: 8 Joi schemas (`BankAccount`, `BankReconciliation`, `CashManagement`, `Expense` ×2, `VendorPayment` ×2, `CustomerCollection`) validated `currency` directly against the raw lowercase list with no `.uppercase()` mapping — a genuine `"USD"` would 400 there — and 3 service-layer `config.supportedCurrencies.includes(currency)` checks (`CashManagementService`, `BankAccountService`, `ExpenseService`) would reject it identically. Fixed with one line at Finance's own re-export site (`supportedCurrencies: bookingConfig.supportedCurrencies.map((c) => c.toUpperCase())`), not by touching `bookingConfig.js` itself — Booking/GDS/Flight/Hotel keep their own lowercase convention untouched. Verified: full suite still green (254/254), and `config.supportedCurrencies.includes('USD')` now `true`.

## New models
- **`CurrencyModel`** (`currency`) — the tenant's own currency registry. Exactly one `isBaseCurrency: true` row per tenant ("Company Base Currency"), enforced in `CurrencyService.createCurrency` (unsets any prior holder before setting a new one), not by a database constraint.
- **`ExchangeRateModel`** (`exchange_rate`) — immutable historical rate log. No update/delete endpoint exists at all; a correction is a new row with a later `effectiveDate`. "Immutable Posted Rates" / "Historical Rate Preservation" are architectural, not just documented intent.
- **`CurrencyRevaluationModel`** (`currency_revaluation`) — one row per (target record, revaluation run); each run's `previousBaseAmount` is the prior run's own `currentBaseAmount` — a real rolling period-over-period baseline, the way revaluation actually works in real accounting (compare to the last reporting date, not always back to the original transaction date).

## Real resting states only
`currencyStatuses` = `Draft, Active, Suspended, Archived`. "Currency Created -> Rate Imported -> Validated -> Activated -> Used" is the pipeline TO activation, not four separate resting states — a currency simply starts `Draft` and becomes `Active`; "Rate Imported"/"Validated"/"Used" have no distinguishing trigger of their own (same collapse discipline as every prior Part).

## Endpoint Contract: POST /api/v1/currencies
Validate Currency -> Validate ISO Code -> Approval Workflow -> Activate Currency -> Audit -> Publish `CurrencyCreated`.

### Request
```json
{ "currencyCode": "USD", "name": "US Dollar", "decimalPlaces": 2, "baseCurrency": false }
```
`name`/`decimalPlaces`/`symbol` all auto-fill from the real ISO 4217 reference table (`utils/iso4217.js`) when omitted — a genuinely curated, stable reference dataset (major/regionally-relevant currencies, including every one this codebase's own defaults already mention: PKR, USD, EUR, GBP, AED, SAR), not the full ~180-code list, which would be unmaintainable dead weight here.

### Validation Rules
Valid ISO 4217 code (format + presence in the reference table); unique per tenant; `CURRENCY_APPROVAL_REQUIRED` gates auto-activation (same single configurable gate as Journal's/Invoice's own, since no concrete multi-tier policy was given).

### Permission
`finance.currency.manage`

### Domain Events
`CurrencyCreated`, `CurrencyActivated` (only when auto-activated)

---

## Endpoint Contract: GET /api/v1/currencies, GET /{currencyId}, POST /{currencyId}/activate, /suspend, /archive

### Permission
`finance.currency.read` (reads), `finance.currency.manage` (activate/suspend/archive)

### Validation Rules
The tenant's own base currency cannot be suspended or archived.

### Domain Events
`CurrencyActivated`

---

## Endpoint Contract: POST /api/v1/exchange-rates, GET /api/v1/exchange-rates
Validate Currency Pair -> Validate Rate -> Store Historical Rate -> Publish `ExchangeRateUpdated`.

### Request
```json
{ "fromCurrency": "USD", "toCurrency": "PKR", "rate": 305.45, "effectiveDate": "2027-05-01" }
```

### Query Parameters (GET)
`fromCurrency`, `toCurrency`, `effectiveDate`, `provider`, `rateType`

### Permission
`finance.currency.manage` (create), `finance.currency.read` (list)

### Domain Events
`ExchangeRateUpdated`

---

## Endpoint Contract: POST /api/v1/exchange-rates/import
"Automatic Rates... Open Exchange APIs." A real HTTP call (Node's own global `fetch` — no SDK needed) against openexchangerates.org's real latest-rates endpoint, gated by `OPEN_EXCHANGE_RATES_APP_ID` — honestly throws "not configured" rather than fabricating a rate when unset, the same discipline as every external integration this codebase has ever wired (SMTP, payment gateways, delivery adapters). Only imports rates for currencies the tenant has actually created (real, scoped — not all ~170 codes the provider returns). Central Bank / Commercial Bank / Custom Provider rate sources have no real code path this pass (no credentials/contracts exist for any of them) — a rate can still be recorded manually under those provider names via `POST /exchange-rates`.

### Permission
`finance.currency.manage`

### Domain Events
`RateImported`

---

## Conversion Engine
`CurrencyService.getRate`/`convert` resolve the best available rate for `fromCurrency -> toCurrency` as of a given date, in order: (1) a direct stored rate, (2) the real mathematical inverse of a stored reverse-pair rate, (3) triangulation through the tenant's own base currency (`from -> base`, then `base -> to`) when neither direct pair is on file. Never fabricates a rate — a genuinely unresolvable pair throws, rather than defaulting to `1`. `GET /api/v1/currencies/convert?amount=...&fromCurrency=...&toCurrency=...` exposes this directly; the result is rounded to the target currency's own real `decimalPlaces`.

### Permission
`finance.currency.read`

---

## FX Gain/Loss & Revaluation
"Realized Gain, Realized Loss, Unrealized Gain, Unrealized Loss... Automatic period-end revaluation." `calculateGainLoss` is the one real function both cases share — revaluation (`POST /api/v1/currencies/revalue`, or the automatic monthly cron) always produces the Unrealized pair, comparing a still-open foreign balance's base-currency value now against its last recorded value; a Realized figure would use the identical math at actual settlement instead, which this pass doesn't wire into AR/AP settlement itself (see Deferred below). The sign flips for a liability (AP): a foreign-currency payable's base-currency value rising is a **Loss** (it now costs more base currency to settle), the mirror-opposite of an asset (Bank/AR), where rising is a **Gain** — verified directly in `tests/currencyService.test.js`.

Revaluation reads real, live balances straight off the already-shipped `BankAccountModel.balances.current`, `AccountsReceivableModel.outstandingBalance`, and `AccountsPayableModel.outstandingBalance` — no schema changes to any of those three models. A gain/loss only posts a real GL journal entry (via the same `_postAutomaticJournal` pattern every other Part uses) when both `FX_GAIN_ACCOUNT_CODE`/`FX_LOSS_ACCOUNT_CODE` AND the target's own control account (`arControlAccountCode`/`apControlAccountCode`/the bank account's own `glAccountCode`) are configured — otherwise the revaluation record is still created, just without a ledger posting, the same "skip until configured" fallback used everywhere else in this module.

### Permission
`finance.currency.manage` (run), `finance.currency.read` (list history)

### Domain Events
`CurrencyRevalued`, `FXGainCalculated` (only when the net movement is a gain), `FXLossCalculated` (only when it's a loss)

---

## Multi-Currency Reporting
`GET /api/v1/currencies/exposure` — a real, live FX exposure snapshot: every open foreign-currency balance across the three real revaluation targets, grouped by currency, netted (bank + receivable − payable), and converted to base currency at today's rate. Computed fresh from live data every call, not a stored report — same pattern as Vendor Payment's own `suggestPaymentTiming`. "Branch Reports"/"Legal Entity Reports" are dropped per the standing tenant-only architecture; "Custom Reporting Currency" is available for free — `convert` accepts any target currency, not just the tenant's own base currency.

### Permission
`finance.currency.read`

---

## Domain Events (Part 19 Summary)
`CurrencyCreated`, `CurrencyActivated`, `ExchangeRateUpdated`, `RateImported`, `CurrencyRevalued`, `FXGainCalculated`, `FXLossCalculated`.

`HistoricalRateArchived` (named in the spec's own Domain Events list) is **not published** — this pass's rate model has no archival/expiry action of its own (a stored rate simply stops being "the latest" once a newer one exists for the same pair; nothing is ever deleted or explicitly archived), so there is no real trigger to fire it from. Documented here rather than firing it from a made-up trigger, per the standing "never invent a reason to fire a named event" discipline.

## Deferred / not built this pass
- **Realized FX Gain/Loss at actual settlement** — `calculateGainLoss` is ready and unit-tested for this; wiring it into `AccountsReceivableService.allocatePayment`/`AccountsPayableService.allocatePayment` (comparing the rate at original booking vs. the rate at settlement) would need those two models to store the rate/base-amount at booking time, which they don't today. Real, but out of scope for this Part — flagged as the natural next increment rather than guessed at now.
- **Central Bank / Commercial Bank / Custom rate providers** — no real credentials/contracts exist for any of them in this codebase; only Manual entry and the real Open Exchange Rates HTTP integration have a genuine code path.
- **Loans / Investments revaluation targets** — no Loan or Investment module exists anywhere in this codebase to revalue; only Bank Accounts/AR/AP (all three already real, already shipped) are wired.
- **`HistoricalRateArchived`** — see above; no real trigger exists for it this pass.
- **Currency Platform / Financial Valuation Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Enterprise Currency Platform" (Currency Manager/Exchange Rate Engine/Conversion Engine/Revaluation Engine/FX Gain-Loss Engine/Rate Provider Manager/Audit Engine/Ledger Integration/Event Publisher) and, above that, a "Financial Valuation Platform" adding Fair Value/Market Data/Consolidation engines for IFRS/GAAP multinational reporting. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `CurrencyService` already fills the real role directly, and Fair Value/Market Data/Consolidation have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 20 — Enterprise Tax Engine APIs

## Overview
"A real ERP never hardcodes tax logic. It uses a centralized Tax Engine." `TaxService` is that engine: a real, versioned, effective-dated, country-aware `TaxRuleModel` replaces the literal `tax = amount * 0.15` anti-pattern the spec opens with — and, critically, replaces the ONE place this codebase actually had a version of that anti-pattern already.

## A real gap closed, not just a new module
Analysis (per the standing master instructions' Step 1) found this module already partially existed: Finance Module Part 9 (Invoices) shipped a "Minimal, real tax-code -> rate lookup" — `resolveTaxRate`/`computeLineTotals` in `InvoiceService.js`, reused as-is by `CreditNoteService.js` and `DebitNoteService.js` — sourced from a single static `config.taxCodes` array (`utils/financeConfig.js`, itself explicitly documented as "NOT the full future Tax Engine"). Per Step 1.3 ("if it already exists → enhance/complete it, don't duplicate"), this Part does not leave that static array as a second, parallel, hardcoded tax system alongside the new one — it becomes `TaxService`'s own last-resort fallback, and all three call sites (`InvoiceService.createInvoice`/`updateInvoice`, `CreditNoteService.createCreditNote`, `DebitNoteService.createDebitNote`) now resolve their tax codes through the real, DB-backed `TaxService.resolveRatesForCodes` first. The pure, already-tested `resolveTaxRate`/`computeLineTotals`/`computeCreditLineTotals`/`computeDebitLineTotals` functions themselves are untouched — only what array gets fed into them changed, so every one of their existing unit tests (which never touch the DB) stayed green with zero modification, verified directly (262/262 passing after the change).

A real correctness improvement fell out of this for free: Credit Notes now resolve the original invoice's tax codes **as of the invoice's own `issueDate`**, not "today" — reproducing the exact historical rate the invoice was raised under even if that rate has since changed, something the pre-Part-20 static lookup could never do (it had no concept of a rate changing over time at all).

## New models
- **`TaxRuleModel`** (`tax_rule`) — the real, versioned, effective-dated rule registry. One row per (taxCode, country[, state], effectiveDate) version, never edited after creation. Creating a new Approved version for the same (taxCode, country, state) automatically closes out any prior open-ended version (`endDate` = new rule's `effectiveDate` − 1 day, `status: "Superseded"`) — real database-enforced versioning, not just a documented promise.
- **`TaxExemptionModel`** (`tax_exemption`) — certificate-based, per-party (customer/vendor), dated exemptions `TaxService.calculateTax` checks before applying tax.
- **`TaxCalculationModel`** (`tax_calculation`) — one immutable row per real `POST /tax/calculate`/`/tax/withholding/calculate` call, the source Tax Reporting aggregates from. Each line's own `direction` (`Output`/`Input`, derived from `transactionType`) is what lets a report net sales-side tax collected against purchase-side tax paid.
- **`TaxReportModel`** (`tax_report`) — a real, immutable, timestamped snapshot of each report generation, so a period's filed figures never silently drift if new transactions land after the fact.

## Real resting states only
`taxRuleStatuses` = `Draft, Approved, Expired, Archived, Superseded`. The spec's own "Draft -> Reviewed -> Approved -> Effective -> Active" collapses "Reviewed" into "Draft" (no separate review-only action was given) and "Effective"/"Active" into "Approved" — whether an Approved rule is *currently* effective is computed from its own `effectiveDate`/`endDate` at resolution time (`TaxService.resolveApplicableRule`), not a status a cron mutates daily; a date range a record already stores is the more correct source of truth than a periodically-recomputed flag. "Expired" is the one status that IS cron-driven (`services/taxRuleExpiryScheduler.js`), since firing the named `TaxRuleExpired` event needs a real trigger.

## Endpoint Contract: POST /api/v1/tax-rules
Validate Jurisdiction -> Validate Formula -> Approval Workflow -> Activate Rule -> Audit -> Publish `TaxRuleCreated`.

### Request
```json
{ "taxCode": "VAT15", "description": "Standard VAT", "rate": 15, "country": "UAE", "effectiveDate": "2027-01-01" }
```
`rate` is a percentage number (`15` means 15%), matching the spec's own example — converted to a fraction only at the point `resolveRatesForCodes` bridges into the pre-existing `resolveTaxRate` (which expects `0.15`).

### Validation Rules
Valid country + taxType + calculationMethod (config-driven); unique per (taxCode, country, state, effectiveDate); `compoundOnTaxCodes` required when `calculationMethod` is Compound; `withholdingCategory` required when `taxType` is WithholdingTax; `TAX_RULE_APPROVAL_REQUIRED` gates auto-activation (same single configurable gate as Journal's/Invoice's/Currency's own).

### Permission
`finance.tax.manage`

### Domain Events
`TaxRuleCreated`, `TaxRuleApproved` (only when auto-approved)

---

## Endpoint Contract: GET /api/v1/tax-rules, GET /{taxRuleId}, POST /{taxRuleId}/approve, /archive

### Permission
`finance.tax.read` (reads), `finance.tax.approve` (approve), `finance.tax.manage` (archive)

### Domain Events
`TaxRuleApproved`

---

## Endpoint Contract: POST /api/v1/tax/calculate
Identify Jurisdiction -> Resolve Applicable Rules -> Calculate Line Taxes -> Calculate Document Taxes -> Apply Exemptions -> Return Tax Breakdown. Persists one immutable `TaxCalculationModel` row and publishes `TaxCalculated` — a real, callable engine every other module can integrate with, not a stateless calculator.

### Request
```json
{ "customerCountry": "UAE", "transactionType": "Invoice", "currency": "AED", "lines": [{ "amount": 1000, "taxCode": "VAT15" }] }
```

### Tax Calculation
"Inclusive Tax, Exclusive Tax, Compound Tax, Cascading Tax... Minimum Tax, Maximum Tax." Exclusive/Inclusive are real (`computeExclusiveTax`/`computeInclusiveTax`, unit-tested including the inclusive round-trip). "Compound Tax" and "Cascading Tax" are the same real recursive mechanism here, not two parallel implementations: a rule's own `compoundOnTaxCodes` names other codes whose tax is resolved and calculated first (against the same raw line amount), and the sum is folded into this rule's own basis before its rate applies — supports arbitrary chains (e.g. India's CGST+SGST, Canada's GST-then-PST), guarded against a circular reference. Min/Max caps apply after computation, before exemption/reverse-charge treatment.

### Tax Exemptions
"Government, Diplomatic, Educational, Medical, Export, Charity. Certificate based." An `Active` `TaxExemptionModel` matching the request's `partyType`/`partyId` (and either covering `applicableTaxCodes` or blanket-exempting) zeroes that line's tax and flags `exempted: true` — the basis/rate are still recorded for the audit trail, never dropped.

### Reverse Charge
"Domestic, International, B2B, B2C. Country-specific policies." A rule opts into one or more scopes (`reverseChargeScopes`); the caller declares which scope(s) the actual transaction matches (`reverseChargeContext`) — reverse charge only applies when both agree, never assumed from country alone. A reverse-charged line's tax is still computed and recorded (for the buyer's own self-assessment reporting) but excluded from `documentTaxTotal` — the seller never remits tax it never collected.

### Response Includes
Per the spec: Line Tax, Document Tax, Tax Code, Tax Rate, Tax Amount, Tax Basis, Jurisdiction, Calculation Method — all present on the persisted `TaxCalculationModel` record this endpoint returns.

### Permission
`finance.tax.read`

### Domain Events
`TaxCalculated`, `TaxExemptionApplied` (only when a line was exempted), `ReverseChargeApplied` (only when a line used it)

---

## Endpoint Contract: POST /api/v1/tax/withholding/calculate
*(Gap-fill — "Withholding Tax... Supplier Payments, Professional Services, Contractors, Dividends, Interest. Automatic deduction," with no endpoint contracted beyond the named `WithholdingTaxCalculated` event.)* A pure calculation + immutable record, the same "conversion utility used by callers" pattern as Part 19's own `CurrencyService.convert` — actually deducting this from a real payment is the calling module's own job (e.g. a future `VendorPaymentService` integration), not this engine's.

### Permission
`finance.tax.read`

### Domain Events
`WithholdingTaxCalculated`

---

## Endpoint Contract: POST /api/v1/tax-exemptions, GET, POST /{exemptionId}/revoke

### Permission
`finance.tax.manage`

---

## Tax Reporting
`POST /api/v1/tax/reports` (generate), `GET /api/v1/tax/reports` (list) — "VAT Return, GST Return, Sales Tax Return, Withholding Return, Country Specific Reports." Real aggregation over `TaxCalculationModel` for the requested period, grouped by taxCode, netting `Output` against `Input` tax (`netPayable = outputTax − inputTax`) — the real, standard VAT/GST-return shape. `reportType` maps to a real `taxType` filter (`VATReturn -> VAT`, etc.) except `Custom`, which aggregates every taxType present. Publishes `TaxReportGenerated`.

### Permission
`finance.tax.manage` (generate), `finance.tax.read` (list)

### Domain Events
`TaxReportGenerated`

---

## Domain Events (Part 20 Summary)
`TaxRuleCreated`, `TaxRuleApproved`, `TaxCalculated`, `TaxExemptionApplied`, `ReverseChargeApplied`, `WithholdingTaxCalculated`, `TaxReportGenerated`, `TaxRuleExpired`.

## Deferred / not built this pass
- **State/County/City/PostalCode/BusinessZone jurisdiction depth** — only Country (required) and State (optional refinement) are real jurisdiction keys this pass; the spec's own endpoint contracts never supply anything finer than `customerCountry`, so County/City/PostalCode/BusinessZone resolution would be guessed at rather than built against a real requirement.
- **Realized withholding-tax deduction inside an actual payment flow** — `calculateWithholdingTax` is real and ready; wiring it as an automatic deduction inside `VendorPaymentService.executeVendorPayment` (reducing the actual bank debit) is the natural next increment, not built here to avoid guessing at exactly which payment types should auto-withhold.
- **Electronic Filing Integration** — no country's e-filing API/credentials exist anywhere in this codebase; `TaxReportModel` produces the real figures a human would still file manually.
- **Central Bank / Commercial Bank / Custom rate-equivalent tax data providers** — every tax rule in this pass is created manually (`POST /tax-rules`); no external tax-rate provider integration exists (unlike Part 19's real Open Exchange Rates HTTP call — no comparable free/standard tax-rate API exists to integrate against honestly).
- **Enterprise Tax Platform / Regulatory Compliance Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Enterprise Tax Platform" (Rule/Jurisdiction/Calculation/Exemption/Compliance/Reporting/Audit engines) and, above that, a "Regulatory Compliance Platform" adding E-Invoicing/Digital Signature/Document Retention engines. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `TaxService` already fills the real role directly, and E-Invoicing/Digital Signature/Document Retention have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 21 — Enterprise Discount & Pricing Engine APIs

## Overview
"The ERP should never let individual modules calculate discounts independently. Instead, every module should ask a centralized Pricing & Discount Engine." `PricingService` is that engine — real, versioned, effective-dated `PricingRuleModel` rows resolve base price and stacked discounts through the exact pipeline the spec draws (Product Price → Customer Price List → Contract Price → Volume Discount → Seasonal Promotion → Coupon → Loyalty Discount → Tax → Final Price), reusing Part 20's own `TaxService` for the final step rather than reimplementing tax.

## Another real gap closed, exactly like Part 20's own pattern
Analysis found the same shape of "already partially exists" case Part 20 closed: Finance Module Part 9 (Invoices) already had real, tested, per-line `discountType`/`discountValue` (`Percentage`/`Flat`) support in `computeLineTotals`. Per Step 1.3, this Part does not bypass or duplicate that — it stays the mechanism that actually APPLIES a discount. `InvoiceService` now accepts an optional `productCode` per line; when supplied, `PricingService.resolveLinePrice` resolves the real base price and any applicable Volume/Promotion discount, expressed back as a plain `Flat` discountValue so `computeLineTotals` itself needed zero changes — the same "resolve, don't rewrite the pure applier" integration Part 20 used for tax. A line with no `productCode` behaves exactly as it did before this Part existed.

Two real, independent bugs surfaced and were fixed while touching `InvoiceService`'s own Joi schema for this: `unitPrice` was unconditionally `required()` (would have rejected a `productCode`-only line — fixed with a schema-level `.or("unitPrice", "productCode")`), and `taxCode` was validated against only the static `config.taxCodes.map(t => t.code)` fallback list — meaning a real, dynamically-created Part 20 `TaxRuleModel` code (e.g. the spec's own `"VAT15"` example) would have been rejected by Joi before ever reaching `TaxService`. Fixed to a plain format check; `TaxService` itself remains the real source of truth for whether a code resolves.

## No Product/Catalog module exists
Exactly like Part 20's `taxCode`, this codebase has no Product/Catalog model anywhere — `productCode` is a plain, opaque SKU string throughout `PriceListEntryModel`/`PricingRuleModel`/`CouponModel`, real but with no FK to validate against.

## New models
- **`PriceListModel`** / **`PriceListEntryModel`** — a price list (Retail/Wholesale/Distributor/Corporate/Government/Export/Custom, scoped to a customer, a `customerGroup`, or the tenant's own default per currency) with its per-product prices in a separate collection, so one price can be repriced without rewriting the whole list.
- **`PricingRuleModel`** — the real, versioned, effective-dated rule registry, mirroring `TaxRuleModel`'s own design exactly: one flexible model covers `CustomerSpecific`/`Contract`/`Volume`/`Promotion`/`Loyalty` via `ruleType`. Creating a new Approved version of an existing open-ended rule NAME auto-supersedes the old one (`endDate` = new rule's `effectiveDate` − 1 day, `status: "Superseded"`) — the exact same real database-enforced versioning Part 20 introduced, keyed by `ruleName` instead of `(taxCode, country)` to reconcile the spec's own "Unique Rule Name" validation rule with "Rule Versioning... Immutable history" (unique among currently-open versions of a name, not across all time).
- **`CouponModel`** — a real, redemption-tracked entity (kept separate from `PricingRuleModel` — a coupon has a code and real consumption to track, structurally unlike a rule).
- **`PriceCalculationModel`** — one immutable row per real `POST /pricing/calculate` call, the "Calculation Trace" the spec's own Response Includes list names, the real source "historical invoices can always be recalculated using the pricing rules that were effective at the time of sale" depends on.

## Real resting states only
`pricingRuleStatuses` = `Draft, Approved, Expired, Archived, Superseded` — identical collapse discipline to Part 20's own `TaxRuleModel` ("Reviewed"/"Effective"/"Active" aren't separate resting states; "Expired" is the one real, cron-driven status).

## Endpoint Contract: POST /api/v1/pricing-rules
Validate Rule -> Validate Dates -> Approval Workflow -> Activate Rule -> Audit -> Publish `PricingRuleCreated`.

### Request
```json
{ "ruleName": "VIP Customers", "customerGroup": "VIP", "discountType": "Percentage", "discountValue": 10, "effectiveDate": "2027-01-01" }
```
`customerGroup` matches (case-sensitively as stored, resolved case-insensitively from the request) against `CustomerModel.category` — an already-real, already-shipped field (Part 1: `regular`/`premium`/`vip`/`corporate`/`loyalty_member`/...), not a fabricated new segmentation dimension.

### Validation Rules
Unique `ruleName` among currently-open versions; valid date range; a `Contract` rule requires `fixedPrice` or a discount; a `Volume` rule requires at least one tier; `discountType: "BuyXGetY"` requires `buyQuantity`/`getQuantity`; `priority` is required (per the spec's own "Priority Defined" rule).

### Permission
`finance.pricing.manage`

### Domain Events
`PricingRuleCreated`, `PricingRuleApproved` (only when auto-approved), `PromotionActivated` (only when `ruleType: "Promotion"` and auto-approved)

---

## Endpoint Contract: GET /api/v1/pricing-rules, GET /{ruleId}, POST /{ruleId}/approve, /archive

### Permission
`finance.pricing.read` (reads), `finance.pricing.approve` (approve), `finance.pricing.manage` (archive)

### Domain Events
`PricingRuleApproved`, `PromotionActivated` (only for a Promotion-type rule)

---

## Endpoint Contract: POST /api/v1/pricing/calculate
Resolve Price List -> Resolve Contract Price -> Apply Volume Rules -> Apply Promotions -> Apply Coupons -> Apply Loyalty Rules -> Apply Taxes -> Return Final Price. Persists one immutable `PriceCalculationModel` row and publishes `FinalPriceCalculated`.

### Request
```json
{ "customerId": "...", "currency": "USD", "items": [{ "productId": "...", "quantity": 25 }] }
```
`productId` and `productCode` are accepted as the same field (no Product catalog exists to distinguish them — both become the plain SKU string `productCode`).

### Rule Priority & Stacking
"Product Rule -> Customer Rule -> Contract Rule -> Promotion Rule -> Coupon Rule -> Loyalty Rule." Within a `ruleType`, the most specific matching rule wins (`customerId` > `customerGroup` > `productCode` > wildcard, ties broken by `priority` then latest `effectiveDate`) — the exact same specificity-then-priority-then-recency resolution Part 20 established for tax jurisdiction. "Stackable discount rules" — Volume and Promotion discounts apply sequentially against the running (already-discounted) amount by default; a rule flagged `isStackable: false` that wins its own type exclusively skips every other automatic rule for that line (a coupon, being an explicit customer action rather than an automatic rule, still applies regardless).

### Response Includes
Per the spec: Base Price, Applied Rules, Discount Amount, Promotion Amount, Coupon Amount, Tax Amount, Final Price, Calculation Trace — all present on the persisted `PriceCalculationModel` record this endpoint returns.

### Tax Integration
"✓ Tax Integration" (AI Coding Rule) — real, via Part 20's own `TaxService.calculateTax`, called with `direction: "Output"` once discounts are applied. Only activates when the customer's own real `address.country` resolves; skipped (never fabricated) otherwise, same "resolve when possible, honestly skip when not" stance used throughout this session.

### Permission
`finance.pricing.read`

### Domain Events
`FinalPriceCalculated`, `DiscountApplied` (only when at least one rule/coupon/loyalty discount was non-zero), `CouponRedeemed` (only when `redeemCoupon: true` and a coupon was actually applied)

---

## Endpoint Contract: POST /api/v1/price-lists, GET, POST /{priceListId}/entries, GET /{priceListId}/entries

### Permission
`finance.pricing.manage` (writes), `finance.pricing.read` (reads)

---

## Endpoint Contract: POST /api/v1/coupons, GET, POST /{couponId}/revoke
"Coupon Support... Single Use, Multi Use, Expiry Date, Usage Limits, Customer Specific, Product Specific." Real overall/per-customer usage-limit enforcement and product/customer scoping (`isCouponValid`, unit-tested directly). Redemption is opt-in per calculate call (`redeemCoupon: true`) — a coupon's discount previews on every calculate call regardless, but `usedCount`/`redemptions[]` only increment on an explicit redeem, so repeated cart-price checks never silently consume a coupon.

### Permission
`finance.pricing.manage`

### Domain Events
`CouponRedeemed`

---

## Domain Events (Part 21 Summary)
`PricingRuleCreated`, `PricingRuleApproved`, `PromotionActivated`, `CouponRedeemed`, `DiscountApplied`, `FinalPriceCalculated`, `RuleExpired`, `PromotionEnded`.

## Deferred / not built this pass
- **FreeShipping / BundleDiscount / CategoryDiscount / CustomFormula discount types** — all four are accepted as real, valid rule configuration (never rejected), but contribute no discount amount: no Shipping module exists to waive a fee against, no Product/Category catalog exists to group by, and a formula-evaluation engine is its own unscoped feature. Percentage/FixedAmount/BuyXGetY are the three with real calculation logic.
- **Loyalty points/redemption balance** — "Loyalty Discounts" resolves against the customer's own already-real `category` field (`loyalty_member`) as a flat/percentage tier discount; no points-accrual/points-redemption system exists anywhere in this codebase to build a richer engine against.
- **Bundle pricing as a distinct multi-product mechanic** — a "Bundle Discount" `discountType` is accepted but doesn't compute (see above); true bundle pricing (N different products sold together at one fixed price) would need a Bundle/Kit entity this codebase doesn't have.
- **Dynamic Pricing** (named in Business Purpose) — no market-signal/demand-based repricing engine exists; every price in this pass comes from an explicitly configured Price List, Contract, or rule.
- **Enterprise Pricing Platform / Commercial Rules Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Enterprise Pricing Platform" (Price List/Contract/Promotion/Coupon/Loyalty/Volume/Rule-Evaluation engines) and, above that, an "Enterprise Commercial Rules Platform" spanning Pricing/Tax/Promotion/Contract/Loyalty/Eligibility/Approval engines. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `PricingService` already fills the real role directly, and Eligibility/Approval have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 22 — Enterprise Financial Approval Workflow APIs

## Overview
"If each module implements its own approval logic, you'll end up with duplicated, inconsistent workflows that are hard to maintain. The better approach is a centralized Approval Platform." `ApprovalWorkflowService` is that platform: real, versioned, effective-dated `ApprovalWorkflowDefinitionModel` rows drive multi-level Sequential/Parallel/AnyOne/AllRequired/MajorityVote/Conditional approval chains, permission-based approver resolution (this codebase's real RBAC — never a hardcoded role-name allowlist), delegation, SLA-driven escalation, and a real cryptographic digital-signature hash per decision.

## A related-but-different existing system: `utils/WorkflowEngine.js`
Before writing any code, Step 1 analysis found a real, already-shipped system with a similar name: `utils/WorkflowEngine.js` + `WorkflowInstanceModel`, used by Booking/Visa/Travel/Flight/Hotel/Transport/Itinerary/Attendance. It gates a single state transition behind a single required role (`transition.approvalRole`), checked via `userRoles.includes(requiredRole) || includes("admin") || includes("superadmin")` — a flat role-NAME array, not this codebase's tenant-owned `RoleModel.permissions` RBAC. It has no persisted workflow *definition* (transitions are computed fresh from each Travel-domain module's own config file every call), no multi-level chains, no delegation, no escalation, no SLA tracking, and no digital signature. It's real and correct for what it does — gating a Booking/Visa status transition behind one role — but structurally too different to extend into "Manager → Finance Manager → CFO"-style multi-level Finance approval chains without either breaking its existing simplicity for Travel/Visa or bolting on capabilities it was never designed for. Per Step 1.3, this Part builds a fresh, purpose-built engine rather than extending a structurally mismatched one — kept clearly separate (`approval_workflow_definition`/`approval_request`/`approval_delegation` collections, no naming collision with `workflow_instance`), and `WorkflowEngine.js` itself was not modified.

## Scope: one real integration, not a 15-module retrofit
Analysis also found ~15 existing services with their own single-gate approval logic (`JournalService`, `InvoiceService`, `CurrencyService`, `TaxService`, `PricingService`, `VendorPaymentService`, `ExpenseService`, and others) — each real, tested, and working today via its own `XApprovalRequired` boolean or (for Cash Transfer/Vendor Payment) a real dual-authorization count-based array. Retrofitting all 15 onto the new engine in one Part would be a large, high-risk, cross-cutting rewrite of already-shipped, already-tested code for uncertain benefit — well beyond what any single Part in this series has attempted. Per the same "resolve, don't rewrite" discipline Parts 20/21 already established, this Part does exactly ONE minimal, safe, concrete integration: `ExpenseService.submitExpense` — which already has a genuine hand-rolled ORDERED multi-level chain (`computeRequiredApprovalLevels`, Manager → Finance → CFO by amount threshold) — now calls `ApprovalWorkflowService.resolveApprovalLevels("Expense", {amount, department}, tenantId)` first; it falls back to the original, still-real, still-exported, still-tested `computeRequiredApprovalLevels` only when no matching `ApprovalWorkflowDefinitionModel` exists yet for the tenant. A tenant admin can now define/version Expense's own approval chain (or a completely different one, with real conditions) without a code change; Expense's own `approvals[]` recording, budget check, and OCR/reimbursement flow are entirely untouched. The other ~14 gates are explicitly deferred, not silently assumed migrated.

## New models
- **`ApprovalWorkflowDefinitionModel`** — the real, versioned rule registry, mirroring `TaxRuleModel`/`PricingRuleModel`'s own design exactly (auto-supersede on a new open-ended version of the same `name`). Supports `Conditional` via an ordered `branches[]` array (first matching branch's own `approvalType`/`levels` wins) — directly answers "Discount approval depends on discount percentage... Approval changes based on country, branch, or department" from this Part's own opening.
- **`ApprovalRequestModel`** — one live instance per real business entity. `levels` is an immutable snapshot (including concretely resolved approver userIds) taken at `startApproval` time — "Immutable Workflow History": a later change to the definition never retroactively changes an in-flight or completed request.
- **`ApprovalDelegationModel`** — real, dated delegation records; `recordDecision` transparently redirects through an Active delegation when the caller isn't directly assigned but holds one for someone who is.

## Real resting states only
`workflowDefinitionStatuses` = `Draft, Approved, Expired, Archived, Superseded` (identical collapse discipline to every rule-engine Part). `approvalRequestStatuses` = `Pending, Escalated, Approved, Rejected, Cancelled, Expired` — the spec's own "Draft → Submitted → Pending Approval → Approved → Completed" collapses into "Pending" directly (no separate draft-instance concept was contracted) through to "Approved" (reaching full approval IS completion — no separate close action is named, unlike Part 18's own precedented Collected/Closed split).

## Endpoint Contract: POST /api/v1/approval-workflows
Validate Workflow -> Validate Conditions -> Approval Workflow -> Activate Definition -> Audit -> Publish `WorkflowCreated`.

### Request
```json
{ "name": "Vendor Payment Approval", "module": "VendorPayment", "conditions": { "amountGreaterThan": 10000 } }
```

### Approval Rules
Real operators: `amountGreaterThan(OrEqual)`, `amountLessThan(OrEqual)`, `department`, `country`, `customerType`. `Branch`/`Risk Score`/`Business Unit`/`Project`/`Vendor Type` are dropped/deferred — no risk-scoring, business-unit, project, or vendor-type field exists anywhere in this codebase to evaluate them against honestly (unlike `customerType`, which is `CustomerModel.type`, a real, already-shipped field).

### Validation Rules
Unique `name` among currently-open versions; valid `module` (config-driven, seeded with the Finance modules that actually exist); each level requires a real `approverPermissionKey` (Role) or `approverUserId` (User) — never a hardcoded role name; `Conditional` requires at least one branch.

### Permission
`finance.approvalworkflow.manage`

### Domain Events
`WorkflowCreated`

---

## Endpoint Contract: GET /api/v1/approval-workflows, GET /{definitionId}, POST /{definitionId}/approve, /archive

### Permission
`finance.approvalworkflow.read` (reads), `finance.approvalworkflow.approve` (approve), `finance.approvalworkflow.manage` (archive)

---

## Endpoint Contract: POST /api/v1/approvals/start
Resolve Workflow -> Determine Approvers -> Create Approval Tasks -> Send Notifications -> Wait For Decisions -> Return Tracking ID.

### Request
```json
{ "module": "Expense", "entityId": "..." }
```
`context` (e.g. `{amount, department, country, customerType}`) drives condition matching and is stored on the request for full audit reproducibility.

### Approvers & Notifications
Role-based levels resolve to real users via `RoleModel.permissions` → `UserModel.role` (this codebase's actual RBAC — never a hardcoded role-name allowlist, the exact anti-pattern `tests/accessScopeRegression.test.js` already guards this codebase against elsewhere); `admin` always counts as eligible, the same universal override every controller's own `hasPermission()` already grants. Real notifications reuse Part 8's own `services/delivery/` adapters (Email/SMS/WhatsApp/Webhook) — Push/Teams/Slack have no real surface in this codebase, same honest "NotConfigured" treatment every other Part gives an unimplemented channel.

### Permission
`finance.approvalworkflow.manage`

### Domain Events
`ApprovalStarted`, `ApprovalAssigned` (once per level notified)

---

## Endpoint Contract: POST /api/v1/approvals/{approvalId}/decision
Validate Permission -> Record Decision -> Check Remaining Approvals -> Continue Workflow -> Complete Workflow -> Publish `WorkflowCompleted`.

### Request
```json
{ "decision": "Approved", "comments": "Budget Verified" }
```

### Approval Types
Real, distinct completion semantics for all six named types (`evaluateApprovalProgress`, unit-tested directly for every one): **Sequential** — only the current level's approvers may decide; a level needs its own `minApprovals` before advancing; any rejection anywhere rejects the whole request. **Parallel** — every level is eligible from the start; completes once every level independently satisfies its own `minApprovals`. **AnyOne** — a single Approved from any assigned approver completes immediately. **AllRequired** — every assigned approver (flattened across levels) must approve. **MajorityVote** — a strict majority of all assigned approvers decides the outcome. **Conditional** is not a seventh execution mode — it's resolved to one of the other five via the definition's own `branches` at `startApproval` time (see `resolveBranch`).

### Digital Signature
"Electronic Signature, Certificate Validation, Approval Hash, Timestamp, Non-Repudiation." Every decision carries a real SHA-256 hash (`computeSignatureHash`, unit-tested for determinism and input-sensitivity) over `(requestId, levelIndex, approverId, decision, timestamp)` — independently reproducible/verifiable given the same inputs. "Certificate Validation" (real PKI/X.509) is honestly not implemented — no certificate infrastructure exists anywhere in this codebase.

### Permission
None beyond a valid tenant/session — enforcement is "are you an assigned approver (directly or via an Active delegation)," validated inside the service itself, not a coarse permission key.

### Domain Events
`ApprovalDelegated` (only when decided via delegation), `ApprovalApproved`/`ApprovalRejected` (per decision), `WorkflowCompleted` (only when the request reaches a final Approved outcome)

---

## Endpoint Contract: POST /api/v1/approvals/{approvalId}/cancel

### Domain Events
`WorkflowCancelled`

---

## Endpoint Contract: POST /api/v1/approval-delegations, GET, POST /{delegationId}/revoke
"Delegation... Temporary Delegate, Permanent Delegate, Out of Office, Approval Proxy." "Approval Proxy" is the same real mechanism as the other three (one user's decisions recorded on another's behalf) — not a fourth parallel implementation. A Permanent delegation cannot carry a `validUntil` date.

### Permission
`finance.approvalworkflow.manage`

---

## SLA & Escalation
`services/approvalEscalationScheduler.js` runs hourly (finer-grained than every other Part's own daily/monthly job, since SLA deadlines are measured in hours) — real, cron-driven, mirrors `receivableOverdueScheduler.js`'s own cross-tenant query pattern. A Pending request whose current level's `slaDeadline` has passed moves to `Escalated` and, when the definition's own `escalation.enabled`/`escalateToPermissionKey` are configured, notifies the resolved escalation target(s) — same "skip until configured" fallback as every optional feature in this module if left unset.

### Domain Events
`ApprovalEscalated`

## Domain Events (Part 22 Summary)
`WorkflowCreated`, `ApprovalStarted`, `ApprovalAssigned`, `ApprovalDelegated`, `ApprovalApproved`, `ApprovalRejected`, `ApprovalEscalated`, `WorkflowCompleted`, `WorkflowCancelled`.

## Deferred / not built this pass
- **Full retrofit of the ~14 other existing single-gate approvals** (Journal, Invoice, Currency, TaxRule, PricingRule, VendorPayment, CashTransfer, ...) — see "Scope" above; each stays on its own existing, working, tested approval logic. `ExpenseService` is the one proven integration.
- **Dynamic approverType** (e.g. "the requester's own manager") — no `reportsTo`/`managerId` field exists on `UserModel` anywhere in this codebase to resolve a real management hierarchy from; only `Role` (permission-based) and `User` (a specific person) are real this pass.
- **Risk Score / Business Unit / Project condition dimensions** — no scoring engine, business-unit field, or (Finance-accessible) Project entity exists to evaluate these against honestly.
- **Real digital certificate validation / PKI** — the signature hash is real and independently verifiable; X.509 certificate-based signing is not implemented (no certificate infrastructure exists).
- **Push Notification / Microsoft Teams / Slack channels** — no real integration exists for any of the three; requesting them is still honestly recorded as `NotConfigured`, never silently dropped.
- **Enterprise Approval Platform / Enterprise Workflow Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Enterprise Approval Platform" (Workflow Definition/Rule Evaluation/Approval/Delegation/Escalation/Notification/Digital Signature/Audit engines) and, above that, an "Enterprise Workflow Platform" generalizing approvals into onboarding/procurement/incident/document-review workflows. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `ApprovalWorkflowService` already fills the real role directly, and the broader business-process/automation/task-management pieces have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 23 — Enterprise Settlement Engine APIs

## Overview
"A payment is when money is authorized or captured. A settlement is when the money is actually transferred and finalized between financial parties." `SettlementService` is the real distinction between the two: batching, per-gateway fee calculation, split payouts, reconciliation against real bank transactions, and adjustments — all built on top of the already-real Payment Engine (Part 7) rather than duplicating it.

## A real gap closed first
Before writing any code, Step 1 analysis found something concrete: Part 7's own `paymentStatuses` config has listed `'Settled'` since the Payment Engine first shipped, and read predicates across the codebase (`isPaymentRefundable`, Part 8's own `receiptEligiblePaymentStatuses`) have always treated it as a real, reachable status — but a grep for any actual assignment (`payment.status = "Settled"` / `status: "Settled"`) across the entire codebase returned nothing. `'Settled'` had been a listed-but-never-reachable status since Part 7. `SettlementService.completeSettlement` is the real trigger now, via a small, minimal, new `PaymentService.markSettled` method (mirroring `void`/`refund`'s own exact style) — the first genuine setter this status has ever had, verified directly (`tests/paymentService.test.js` still green after the change).

## Real reuse across six prior Parts, not a self-contained silo
Per Step 1's "connects to existing architecture" requirement, this Part deliberately reuses rather than reimplements:
- **Fee/net calculation** is new and real (`computeSettlementFees`/`computeNetAmount`, unit-tested), but **FX Adjustment** reuses `CurrencyService.convert` (Part 19) directly when the settlement account's own currency differs from the payment's.
- **"Sent To Bank"** reuses `services/paymentFileGenerators/` (CSV/ACH/SEPA/SWIFT MT) directly — the exact real generators Part 17 built for vendor payments, framed here as a settlement remittance/advice file rather than a parallel file-generation implementation.
- **Crediting the settlement account** reuses `BankAccountService.applyTransaction` (Part 13) directly — the same real, append-only `BankTransactionModel` ledger every other money-in event already posts through.
- **"Split Settlements... Vendor Share, Partner Share"** reuse `VendorCreditService.createCredit` (Part 6/17) directly for any split naming a real vendor payee — the same real vendor-credit mechanism Part 17's own vendor advances used.
- **"Settlement Reconciliation... Automatic matching"** reuses Part 14's own real fuzzy-matching engine (`computeMatchScore`, `computeReferenceSimilarity`, `normalizeMatchWeights`, and its own `reconciliationAmountTolerance`/`reconciliationDateToleranceDays`/`reconciliationMatchWeights` config) directly against real `BankTransactionModel` entries — one matching engine for the whole ERP, not a second parallel one.
- **"Settlement Adjustments... Chargebacks"** never reimplements dispute handling — an adjustment of type `Chargeback` only ever links an existing, real Part 12 `ChargebackModel` row (validated to belong to the same payment) via `chargebackId`.
- **"Gateway Reports"** is a real, new capability added to the existing gateway adapter contract: `BaseGatewayAdapter.fetchSettlementReport()` (new, optional method), with a genuine implementation in `StripeGatewayAdapter` using Stripe's real Payouts/Balance Transactions API (gated on the same `STRIPE_SECRET_KEY` every other Stripe call already requires) — `ManualGatewayAdapter` honestly returns an empty result (cash/cheque/manual transfers have no external payout report to fetch).

## New models
- **`SettlementModel`** — one row per payment being settled; "Settlement history is immutable" — corrections are real, separate `SettlementAdjustmentModel` rows, never edits to a completed settlement's own figures.
- **`SettlementBatchModel`** — mirrors Part 17's own `PaymentBatchModel` design closely.
- **`SettlementAdjustmentModel`** — the real, append-only adjustment log; `Chargeback` links Part 12's `ChargebackModel` rather than duplicating it.

## Real resting states only
`settlementStatuses` = `Pending, Sent, Processing, Completed, Failed, Reversed, Disputed, Cancelled`. "Validated" collapses into "Pending" (validation happens inline inside `createSettlement`); "Grouped Into Batch" collapses into the settlement's own `batchId` being non-null rather than a separate status value — the same "a field already encodes this" reasoning Part 22 applied to workflow rule effective-dating.

## Endpoint Contract: POST /api/v1/settlements
Validate Payment -> Validate Settlement Account -> Calculate Fees -> Create Settlement -> Publish `SettlementCreated`.

### Request
```json
{ "paymentId": "...", "settlementAccount": "...", "settlementDate": "2027-06-01" }
```

### Validation Rules
Payment exists and is Captured/Allocated (not already being settled — one active settlement per payment); settlement account is a real, Active `BankAccountModel`; currency match, or a real FX conversion when the account's own currency differs.

### Permission
`finance.settlement.create`

### Domain Events
`SettlementCreated`, `SettlementValidated`

---

## Endpoint Contract: GET /api/v1/settlements, GET /{settlementId}, POST /{settlementId}/cancel, /complete

### Response Includes
Per the spec: Settlement ID, Settlement Batch, Payment Reference, Gross Amount, Fees, Net Amount, Currency, Settlement Date, Status, Created Date — all present on `SettlementModel`.

### Permission
`finance.settlement.read` (reads), `finance.settlement.manage` (cancel/complete)

### Domain Events
`SettlementCompleted`, `SettlementFailed` (when the real bank-credit/journal step throws)

---

## Endpoint Contract: POST /api/v1/settlement-batches, GET, GET /{batchId}, POST /{batchId}/send, /complete

### Permission
`finance.settlement.read` (reads), `finance.settlement.manage` (writes)

### Domain Events
`SettlementBatchCreated`, `SettlementSent`

---

## Endpoint Contract: POST /api/v1/settlements/{settlementId}/adjustments

### Permission
`finance.settlement.manage`

### Domain Events
`SettlementReversed` (only for a Reversal-type adjustment)

---

## Endpoint Contract: POST /api/v1/settlements/reconcile, GET /settlements/gateway-report

### Permission
`finance.settlement.manage` (reconcile), `finance.settlement.read` (gateway report)

### Domain Events
`SettlementReconciled` (per matched settlement)

---

## Domain Events (Part 23 Summary)
`SettlementCreated`, `SettlementValidated`, `SettlementBatchCreated`, `SettlementSent`, `SettlementCompleted`, `SettlementFailed`, `SettlementReversed`, `SettlementReconciled`.

## Deferred / not built this pass
- **Scheduled/automatic batch creation** (Daily/Weekly/Monthly batch types are real and selectable, but nothing auto-creates a batch on a schedule) — no endpoint contract or named domain event requires a cron trigger here, unlike Parts 20–22's own `XExpired`/`ApprovalEscalated` events; batches are created on demand via the real endpoint. Flagged as the natural next increment rather than guessed at now.
- **Merchant/Marketplace-report reconciliation sources** — only "Bank Statements" (via Part 14's real matching against `BankTransactionModel`) and "Gateway Reports" (via the new, real `fetchSettlementReport`, Stripe only) are wired; no merchant-specific report format exists to parse honestly.
- **PayPal/Square/AuthorizeNet/Adyen/Razorpay gateway settlement reports** — `getGatewayAdapter` only resolves `Manual`/`Stripe` (Part 7's own existing scope); the other configured gateway values already surface a clear "not yet supported" error at the Payment Engine level, unchanged here.
- **Tax fee line real jurisdiction resolution** — `Tax` is a real, configurable percentage in the fee schedule (same math as every other fee type); wiring it through Part 20's own `TaxService` for real jurisdiction-aware calculation was left out to avoid conflating a gateway/processing fee with sales-tax jurisdiction logic they don't actually share.
- **Enterprise Settlement Platform / Financial Operations Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Enterprise Settlement Platform" (Settlement Manager/Batch/Split/Fee/Reconciliation/Adjustment/Audit engines) and, above that, a "Financial Operations Platform" spanning Payment/Settlement/Banking/Treasury/Reconciliation/Liquidity platforms. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `SettlementService` already fills the real role directly, and Treasury/Liquidity have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 24 — Enterprise Financial Reporting APIs

## Overview
"The reporting platform should never calculate business transactions directly. Instead, it should read from the General Ledger and other accounting records that have already been posted." `FinancialReportService` takes this literally: it is a thin, real aggregation and presentation layer over sources this codebase already built and already trusts — it introduces almost no new accounting math of its own.

## A real precursor found first: `LedgerService.getTrialBalance`
Before writing any code, Step 1 analysis found that Part 4 (General Ledger) already shipped a real, working `LedgerService.getTrialBalance` — category-aware, cached, with a genuine "total debits = total credits" integrity check. This Part reuses it directly for the `TrialBalance` report type (zero new aggregation), and reuses its *exact same underlying `LedgerEntryModel` aggregation pattern* (not the same function, since Balance Sheet/P&L need different filtering — as-of vs. date-ranged — but the identical real technique) for `BalanceSheet` and `ProfitAndLoss`. No report type in this Part recalculates a business transaction; every one of them reads from what's already posted.

## Reuse across seven prior Parts
- **Trial Balance** → `LedgerService.getTrialBalance` (Part 4), unchanged, called directly.
- **Balance Sheet** → the same trial balance rows, grouped into Assets/Liabilities/Equity (`groupRowsForBalanceSheet`, unit-tested including a real "Assets = Liabilities + Equity" integrity check, mirroring the trial balance's own).
- **Profit & Loss** / **Retained Earnings** → a new, real period-ranged variant of the identical `LedgerEntryModel` aggregation technique, filtered to Revenue/Expense accounts; Retained Earnings composes two P&L runs (prior period + current) plus a real formula (`computeRetainedEarnings`).
- **General Ledger** report → `LedgerService.listEntries` (Part 4), called directly.
- **Journal Register** → `JournalService.listJournals` (Part 3), called directly.
- **AR Aging / AP Aging** → the real, shared `computeAgingBucket` (Part 5/6) — this Part adds the summarized, grouped REPORT view that never existed before (only per-record bucket-stamping did).
- **Tax Reports** → delegates entirely to `TaxService.generateTaxReport` (Part 20) — never a second tax aggregation — wrapped in this module's own unified `FinancialReportModel` envelope purely for consistent history/export/discoverability alongside every other report type.
- **Budget vs Actual** → real variance math (`computeBudgetVariance`) against the already-real `ExpenseBudgetModel` (Part 16).
- **Cash Flow Statement** → real, Direct Method, using the bank ledger's own already-real `direction` field (Part 13) as the inflow/outflow signal — genuinely simpler and more robust than guessing a `type`-to-category mapping.

## New models
- **`FinancialReportModel`** — one immutable row per real generation; re-running the same parameters later produces a new row, never an edit (same discipline as Part 20's `TaxReportModel`). `exports[]` is its own array (a report can be exported multiple times, in multiple formats, without changing its own generation state).
- **`ReportScheduleModel`** — real recurring generation + delivery definitions.

## Real resting states only
`reportStatuses` = `Requested, Generated, Cancelled, Expired, Archived`. "Validated → Data Retrieved → Aggregated → Generated" collapses into the one synchronous `generateReport` call (same collapse discipline as every rule-engine Part this session); "Exported" is deliberately not a status.

## Endpoint Contract: POST /api/v1/financial-reports/generate
Validate Parameters -> Validate Accounting Period -> Retrieve Ledger Entries -> Aggregate Balances -> Generate Report -> Store Report History -> Publish `ReportGenerated`.

### Request
```json
{ "reportType": "BalanceSheet", "period": "2027-Q2", "currency": "USD" }
```
`period` accepts `"YYYY"`, `"YYYY-MM"`, or `"YYYY-Q#"` and resolves to a real date range (`_resolvePeriodRange`); `periodStart`/`periodEnd` can be supplied directly instead. The request schema is deliberately `.unknown(true)` beyond the four common fields — each `reportType` accepts its own real, different extra parameters (`accountId` for General Ledger, `scope`/`period` for Budget vs Actual, `taxReportType`/`country` for Tax Reports, `accountCodes`/`categories` for Custom, ...) rather than one giant schema enumerating every combination.

### Validation Rules
Valid `reportType` (config-driven); a recognized `period` format or explicit dates; valid `currency`. "Period Closed (Optional)"/"Branch Exists" are dropped — no branch dimension exists, and this Part reads whatever periods/data exist rather than requiring a period to be formally closed first (a report should be able to show an in-progress period too).

### Permission
`finance.report.create`

### Domain Events
`ReportRequested`, `ReportGenerated`, `CustomReportCreated` (only for `reportType: "Custom"`)

---

## Endpoint Contract: GET /api/v1/financial-reports, GET /{reportId}, GET /{reportId}/drill-down

### Response Includes
Per the spec: Report ID, Report Type, Accounting Period, Currency, Generated By, Generated Date, Status, Export Formats (`exports[]`) — all present; "Legal Entity"/"Branch" are dropped (no such dimension exists).

### Drill-Down
"Account, Journal Entry, Invoice, Payment, Receipt, Expense, Bank Transaction. Full navigation." Account/Journal Entry drill-down is real and FK-backed (`LedgerEntryModel.accountId`/`journalId`). Resolving further to the ORIGINATING Invoice/Payment/Receipt/Expense/BankTransaction is real but honestly best-effort: journals only carry a plain `referenceNumber` string (Part 3), not a typed FK to whichever document triggered them, so this matches that string against each real candidate collection's own number field in turn — documented as string-matched, not FK-guaranteed.

### Permission
`finance.report.read`

---

## Endpoint Contract: POST /api/v1/financial-reports/{reportId}/export, /archive, /cancel

### Export Formats
Real generation for PDF (`pdfkit`, the same package every other Finance PDF service already uses), Excel (`exceljs`, already installed for Part 14's real statement *parsing*, now used for real *writing*), CSV, and JSON (the report's own already-stored `data`). "API" is simply this endpoint's own sibling GET; "Scheduled Email" is the delivery mechanism below, not a file format. Every report `data` shape (trial-balance-style `rows`, cash-flow-style `lines`, aging-style `buckets`, balance-sheet-style `sections`, or a scalar summary like Retained Earnings) is normalized into one flat table (`flattenReportRows`, unit-tested against every shape) that CSV/Excel/PDF all render from identically.

### Permission
`finance.report.manage`

### Domain Events
`ReportExported`, `ReportArchived`

---

## Endpoint Contract: POST /api/v1/report-schedules, GET, POST /{scheduleId}/cancel
"Report Scheduling: Daily, Weekly, Monthly, Quarterly, Yearly, On Demand." "On Demand" is just calling `POST /financial-reports/generate` directly, not a schedule row. Real, cron-driven (`services/financialReportScheduler.js`) — regenerates the report fresh every run (never replays stale figures), exports it, and emails it via Part 8's own real `EmailDeliveryAdapter`. The same scheduler also expires `Generated` reports past their own `REPORT_RETENTION_DAYS`.

### Permission
`finance.report.manage` (writes), `finance.report.read` (list)

### Domain Events
`ReportScheduled`, `ReportDelivered` (only when the email adapter confirms `Sent`)

---

## Domain Events (Part 24 Summary)
`ReportRequested`, `ReportGenerated`, `ReportExported`, `ReportScheduled`, `ReportDelivered`, `ReportArchived`, `CustomReportCreated`.

## Deferred / not built this pass
- **Consolidation** (Multiple Companies/Legal Entities/Business Units/Intercompany Elimination) — this codebase's own tenant architecture is company-as-tenant with no legal-entity-below-tenant concept and no intercompany transaction model; there is nothing to consolidate across within one tenant, and cross-tenant reporting would breach the tenant isolation boundary itself.
- **Investing/Financing cash flow classification** — the real Direct Method here classifies every bank transaction as Operating (its own `direction` is the only real signal); no transaction-type tagging exists anywhere in this codebase to distinguish an investing or financing activity from an operating one.
- **Push Notification / Microsoft Teams / Slack scheduled delivery** — only real Email delivery is wired (Part 8's own adapter); no real integration exists for the other channels named in this session's own prior Parts either.
- **Custom Reports as a free-form report designer** — "Custom" is a real, honestly-scoped ad-hoc ledger query (caller-supplied account/category/date filters through the same real aggregation every other report type uses), not an unbounded drag-and-drop report builder.
- **Enterprise Financial Reporting Platform / Financial Intelligence Platform** — this Part's own two "Principal Software Architect" sections propose a dedicated "Enterprise Financial Reporting Platform" (Reporting/Aggregation/Consolidation/Drill-Down/Export/Scheduling/Audit/Authorization engines) and, above that, an "Enterprise Financial Intelligence Platform" adding Dashboard/Analytics/Forecasting/KPI/Alert/AI-Insights engines. Neither was built as a distinct architectural layer, for the identical reason given at every prior Part that proposed one: `FinancialReportService` already fills the real role directly, and Forecasting/KPI/Alert/AI-Insights have zero concrete endpoint contracts anywhere in this doc to build against.

---

# Part 25 — Enterprise Financial Dashboard APIs

## Overview
"A report answers 'What happened?' A dashboard answers 'What is happening right now?'" Where Part 24 reads already-posted GL history into an immutable snapshot on request, this Part maintains a live, persisted, tenant-scoped operational read model — cash position, AR/AP outstanding, today's revenue/expense, overdue counts, FX exposure — refreshed by real events and a scheduled fallback, never computed inline on a dashboard request.

## An exact-fit precedent found first: `services/KPIEngine.js` + `VisaAnalyticsEngine.js` + `VisaDashboardController.js`
Unlike Part 22 (where `utils/WorkflowEngine.js` was a structurally different generic-transition engine, not extended), this codebase already runs a real, shipped dashboard subsystem for the Travel/Visa domain with the *identical* shape this Part's own spec describes: `KPIEngine.computeXMetrics`/`refreshXSummary` (real parallel aggregations → upsert a persisted daily summary), `VisaAnalyticsEngine.ensureSummary` (never aggregate transactional tables inline — a missing summary triggers a background `queueMicrotask` refresh and returns a `pendingRefresh: true` stub immediately), `CacheManager.getOrCompute`-wrapped per-dashboard-type reshaping methods, and `VisaDashboardController`'s `handle()`/`dashboardScope()` factory (tenant + permission gate, fire-and-forget audit log, `{...data, meta: {fromCache, generatedAt}}` envelope). This Part **extends `KPIEngine.js`** with `computeFinanceMetrics`/`refreshFinanceSummary`/`buildFinanceAlerts`, and adds `services/FinanceAnalyticsEngine.js` + `controllers/FinancialDashboardController.js` that mirror the Visa files' own method/caching/permission shape exactly — not a second, parallel dashboard system.

## Reuse across nine prior Parts, not a self-contained silo
Every real number on the dashboard already has a real owner: `BankAccountModel.balances.current` (Part 13, Cash/Bank Balance), `AccountsReceivableModel`/`AccountsPayableModel.outstandingBalance` + `isPayableTerminal` (Parts 5/6, Outstanding AR/AP), `AccountsReceivableModel.status === "Overdue"` and a real `dueDate < now` scan of open payables (Overdue Invoices/Payables), `FinancialReportService.getPeriodMovement` — the exact same real GL aggregation Part 24 built for Profit & Loss, now exported as a public wrapper and called a second time with today's date range (Today's Revenue/Expenses), `CurrencyService.getCurrencyExposure` (Part 19, FX Exposure, classified Low/Medium/High against two configurable thresholds), `ExpenseBudgetModel.consumedAmount > allocatedAmount` (Part 16, Budget Exceeded), `PaymentModel` (Part 7, Large Payment), `TaxReportModel.totalNetPayable` (Part 20, Tax Due).

## New models
`FinanceOperationsSummaryModel` (one persisted row per tenant per day — `metrics`/`kpis`/`alerts`, mirrors `VisaAnalyticsSummaryModel` exactly), `DashboardAlertModel` (real, persisted, acknowledgeable — `alertType`/`severity`/`value`/`threshold`/polymorphic `sourceType`+`sourceId`/`status` Active→Acknowledged/Resolved), `DashboardPreferenceModel` (one row per tenant+user+dashboardType — layout/favoriteWidgets/filters/theme/refreshInterval; "Role Defaults" is satisfied by simply having no saved row yet, not a separate default record).

## Real resting states only
`DashboardAlertModel.status`: **Active → Acknowledged | Resolved**. No separate "Triggered"/"Notified"/"Escalated" states — an alert is either live, dealt with by a human, or its underlying condition cleared (resolution is implicit: the next `refreshFinanceSummary` simply stops re-raising it once the metric is back under threshold; nothing marks it "Resolved" automatically today, an honest gap, not a fabricated auto-resolve).

## Endpoint Contract: GET /api/v1/financial-dashboard/{type}
`type` ∈ `executive | cfo | treasury | accounts-receivable | accounts-payable | revenue | expense | cash-flow | tax | custom`. `executive`/`cfo`/`treasury`/`tax` require `finance.dashboard.management` (or `admin`); every type requires `finance.dashboard.read` (or `admin`). Validate Tenant → Validate Permission → `FinanceAnalyticsEngine.ensureSummary` (cache hit or background-refresh stub) → reshape for the requested type → fire-and-forget `DashboardViewed` event + audit log → `{success, message, data: {...metrics/kpis, meta: {fromCache, generatedAt}}}`. `custom` additionally accepts `?metricKeys=cashToday,outstandingAR` to select an arbitrary subset of the same real persisted metrics/kpis — an honestly-scoped ad-hoc dashboard, not a drag-and-drop widget designer.

## Endpoint Contract: GET /api/v1/financial-dashboard/kpis, /trends, /drill-through
`kpis` returns the persisted `kpis` object (grossProfit/netProfit/expenseRatio/workingCapital/currentRatio/quickRatio — quick ratio collapses to current ratio, and gross profit collapses to net profit, since no inventory/COGS concept exists in this chart of accounts; documented, not fabricated as separately-derived figures). `trends` returns a day-by-day snapshot built from `FinanceOperationsSummaryModel` history (`?period=7 Days|30 Days|...`), the same technique as Visa's own `buildTrendSnapshot`. `drill-through?reportId=&accountId=` is exactly Part 24's own `FinancialReportService.drillDown(reportId, {accountId}, tenantId)` — a dashboard number always traces back to the already-generated report it was drawn from, not a second drill-down implementation.

## Endpoint Contract: GET /api/v1/dashboard-alerts, POST /{id}/acknowledge
`GET` (optionally `?status=Active|Acknowledged|Resolved`) lists real persisted alerts for the tenant, newest first. `POST /{id}/acknowledge` (requires `finance.dashboard.management`) flips `Active → Acknowledged`, stamps `acknowledgedBy`/`acknowledgedAt`, publishes `AlertAcknowledged`.

## Endpoint Contract: GET/PUT /api/v1/dashboard-preferences/{dashboardType}
Real per-user, per-dashboard-type layout/favorite-widgets/filters/theme/refresh-interval persistence (`DashboardPreferenceModel`, upserted). `PUT` publishes `DashboardCustomized`.

## Alert generation — real, deterministic, no ML
`KPIEngine.buildFinanceAlerts` (pure, unit-tested in `tests/financeAnalyticsEngine.test.js`) evaluates each real computed metric against a real configured threshold — `DASHBOARD_LOW_CASH_THRESHOLD`, `DASHBOARD_HIGH_EXPENSE_DAILY_THRESHOLD`, `DASHBOARD_LARGE_PAYMENT_THRESHOLD`, `DASHBOARD_TAX_DUE_THRESHOLD`, plus threshold-free real conditions (any overdue receivable/payable, any exceeded budget, negative net cash flow today). Every threshold defaults to `0` (disabled) — nothing fires until a tenant admin configures a real value, and nothing is scored or predicted, only compared. `refreshFinanceSummary` dedupes same-day/same-type/same-source alerts before persisting, so a refresh storm from rapid events doesn't spam duplicate rows.

## Domain Events (Part 25 Summary)
`DashboardViewed`, `DashboardRefreshed`, `KPICalculated`, `AlertTriggered`, `AlertAcknowledged`, `DashboardCustomized`. (`WidgetAdded`/`WidgetRemoved` from the spec have no real backing concept — widgets here are fixed reshaping methods per dashboard type, not a stored, addable/removable widget list; not fabricated.)

## Deferred / not built this pass
- **Real-time push (WebSocket/SSE) refresh** — `RealTime` is a listed, config-driven `dashboardRefreshIntervals` value a user can select as a *preference*, but no push transport exists; every dashboard type is still pull-based (`GET`), same as Visa's own dashboards.
- **Heat Map / Calendar / Gauge / Progress Bar widget renderers** — this Part supplies the real underlying numbers (KPIs, alerts, trends); client-side widget rendering choice is a frontend concern, not a backend contract.
- **Automatic alert resolution** — an alert currently only ever moves `Active → Acknowledged` by a human; nothing re-scans and auto-marks `Resolved` once the underlying metric recovers. An honest gap, not a fabricated auto-resolve.
- **"Enterprise Decision Intelligence Platform"** — this Part's own closing "Principal Software Architect Recommendation" proposes a Forecasting/Simulation/Recommendation/Anomaly-Detection layer above the dashboard. Not built: zero concrete endpoint contracts exist for it anywhere in this doc, same reasoning applied to every prior speculative-platform proposal this session.

---

# Part 26 — Enterprise Financial Analytics APIs

## Overview
"Reports describe. Dashboards monitor. Analytics explains, predicts, and helps optimize." Where Part 24 reads already-posted GL history into an immutable snapshot, and Part 25 maintains a live same-day operational read model, this Part runs on-demand statistical models — trend, forecast, ratio, variance, scenario, anomaly, and (LLM-backed) executive insight — over real historical data, and stores each run as its own immutable analytics record.

## Real historical depth, not a shallow same-day table
Part 25's own `FinanceOperationsSummaryModel` only accumulates one row per tenant per day starting the day it shipped — far too shallow for a 12-month revenue trend the day after launch. Instead, every Trend/Forecast/Ratio/WorkingCapital analysis type samples the two real, already-immutable, arbitrarily-historical sources this codebase already has: `FinancialReportService.getPeriodMovement` (Part 24, real GL Revenue/Expense movement for any date range) and `LedgerService.getTrialBalance({date: asOf})` (Part 4, real as-of-any-past-date balances — ledger entries are immutable and dated, so this works for any historical bucket boundary with zero new schema). `services/FinancialAnalyticsService.js`'s own bucket generator (`generateBuckets`) produces real Weekly/Monthly/Quarterly/Yearly calendar boundaries; each bucket is then a fresh, real, correctly-dated query — never a second parallel calculation of a business transaction, and never dependent on Part 25's own shallow history for depth.

## Statistics, not the spec's "Machine Learning Models"
Forecasting is real ordinary-least-squares linear regression (`linearRegression`/`predictLinear`) over a real bucketed series; Anomaly Detection is a real z-score threshold (`computeZScoreAnomalies`) against a real trailing mean/standard deviation. The spec's own "Machine Learning Models" line item is explicitly NOT built — no training data, no model registry, and no genuine ML library is wired anywhere in this codebase to build one against honestly. Same discipline already applied to Part 25's own "no ML" Tax Due alert.

## Executive Insights reuses the already-real AI infrastructure
`ExecutiveInsights` calls the same, already-wired `services/ai/AIModelRouterService.js` (`AIModelRouterService.route({tenantId, category: "reasoning", messages, tools: [], systemPrompt})`) that `CashManagementService.forecastCashNeeds` (Part 15) already uses for its own real, advisory-only AI cash forecast — not a second, parallel LLM integration. It's fed real 6-month Revenue/Expense trend buckets plus any currently-Active `DashboardAlertModel` rows (Part 25) and asked for structured JSON (`keyDrivers`/`riskIndicators`/`growthOpportunities`/`costSavingOpportunities`/`cashRiskAlerts`/`narrativeSummary`/`recommendations`). On a provider failure or malformed response it returns `{aiAvailable: false, insights: [], recommendations: []}` with the real error message — never a fabricated insight.

## Real dimensional reuse, and what's honestly deferred
`RevenueByCustomer` groups real `InvoiceModel.customerId`/`customerName`; `RecurringRevenue` sums real `InvoiceModel` rows where `invoiceType === "Recurring"` (Part 9's own real type value); `ExpenseCategories`/`CostDrivers` group real `ExpenseModel.category`+`amount` for committed expenses (Approved/Reimbursed/Closed only — Draft/Rejected/Cancelled were never a real cost). The spec's own Product/Department/Project/Country/Branch Profitability, Revenue by Channel/Product, Revenue Mix, and Fixed vs Variable Costs are honestly NOT built: no Product/Department/Channel/Country dimension exists on any revenue-generating record in this codebase (Invoice carries only `customerId`), and no fixed/variable cost-behavior tag exists on any expense category to classify by — not guessed at, same discipline as every prior Part's own Deferred section.

## New model
`FinancialAnalyticsModel` — one immutable row per real run (mirrors `FinancialReportModel`'s own "re-run = new row" discipline exactly): `analysisType`/`period`/`kpis`/`series`/`forecasts`/`insights`/`recommendations`/`confidenceLevel`/`status`/`timeline`. No new "Analytics Engine"/"Forecast Engine"/"Scenario Engine" collections — one service, one model, dispatched by `analysisType`, same "don't build a parallel platform for a spec section with no concrete contract" reasoning already applied to Part 22's WorkflowEngine.js precedent and this doc's own repeated "Principal Software Architect" platform proposals.

## Endpoint Contract: POST /api/v1/financial-analytics/run
`{analysisType, period?, periodStart?, periodEnd?, currency?, ...typeSpecificParams}`. Validate Tenant → Validate Permission (`finance.analytics.run`) → Validate `analysisType` exists in config → Validate `currency` supported → resolve the real historical/forecast bucket range (`FinancialReportService.resolvePeriodRange` for historical types, `parseForecastHorizon` for forward-looking ones) → dispatch to the real per-type computation → store the immutable `FinancialAnalyticsModel` row → publish `AnalyticsCompleted` (+ `ForecastGenerated`/`ScenarioCalculated`/`AnomalyDetected`/`InsightGenerated`/`RecommendationPublished` where applicable) → `{success, message, data: {...analysis}}`. 18 real `analysisType` values — see `utils/financeConfig.js`'s own `analysisTypes` doc comment for the full list and each one's real data source.

## Endpoint Contract: GET /api/v1/financial-analytics, GET /:analysisId
`GET` (optionally `?analysisType=&status=&currency=&period=&page=&pageSize=&sort=`) lists real stored analyses newest-first, `series`/`forecasts`/`insights` excluded from the list projection (same `.select("-data")`-style trim as Part 24's own `listReports`). `GET /:analysisId` returns the full immutable record.

## Endpoint Contract: POST /:analysisId/cancel, POST /:analysisId/archive
Both require `finance.analytics.manage` and only apply from `Completed` status — real resting-state transitions (`Completed → Cancelled` / `Completed → Archived`), mirroring `FinancialReportService.cancelReport`/`archiveReport` exactly.

## A real, honest synergy: ForecastVsActual
Because every analytics run is immutable history, a previously-stored `RevenueForecast`/`ExpenseForecast` can later be checked against what the GL actually posted once that bucket has elapsed — `ForecastVsActual` (`{forecastAnalysisId}`) walks the referenced analysis's own `forecasts[]`, skips any bucket that hasn't elapsed yet ("nothing real to compare against"), and re-queries `FinancialReportService.getPeriodMovement` for each elapsed bucket to compute a real variance. Deliberately scoped to Revenue/ExpenseForecast only (both strictly monthly-bucketed) — CashFlowForecast/WorkingCapitalForecast use variable Weekly/Quarterly/Yearly granularity that isn't reconstructable purely from a stored `bucketOffset`, an honest, deliberate scope limit rather than a fragile generic guess.

## Domain Events (Part 26 Summary)
`AnalyticsRequested`, `AnalyticsCompleted`, `ForecastGenerated` (Revenue/Expense/CashFlow/WorkingCapital forecast types), `ScenarioCalculated`, `AnomalyDetected` (only when ≥1 real anomaly is found), `InsightGenerated`/`RecommendationPublished` (ExecutiveInsights, only on real non-empty output), `AnalyticsArchived`.

## Deferred / not built this pass
- **Machine Learning Models** — see this Part's own "Statistics, not..." section above; real linear regression and z-score thresholds are used throughout instead.
- **Product/Department/Project/Country/Branch Profitability, Revenue by Channel/Product, Revenue Mix, Fixed vs Variable Costs** — no backing dimension exists anywhere in this codebase to build any of them against honestly; see this Part's own "Real dimensional reuse" section.
- **ForecastVsActual for CashFlowForecast/WorkingCapitalForecast** — variable-granularity forecasts aren't safely reconstructable from a stored `bucketOffset` alone; deliberately scoped out rather than guessed at.
- **Scheduled/recurring analytics runs** — `POST /financial-analytics/run` is on-demand only, the same "On Demand real endpoint, no separate schedule row" stance Part 24 already took for reports before its own real `ReportScheduleModel` was added; no scheduling contract was given for Analytics to build a second scheduler against.
- **"Enterprise Financial Analytics Platform" / "Enterprise Business Intelligence & Decision Platform"** — this Part's own two "Principal Software Architect" sections propose dedicated Analytics/Forecast/Scenario/Ratio/Variance/Anomaly/Insight/Recommendation engines as separate services, and, above that, a cross-domain BI platform spanning Sales/Procurement/Inventory/HR. Neither was built as a distinct architectural layer — `services/FinancialAnalyticsService.js` already fills the real role directly, and no Sales/Procurement/Inventory/HR analytics contract exists anywhere in this codebase to build a shared platform against, same reasoning applied to every prior Part's own speculative-platform proposal.

---

# Part 27 — Enterprise Audit & Compliance APIs

## Overview
"A true enterprise Audit & Compliance Platform records who, what, when, where, why, how, before value, after value, approval chain, and whether the action complied with organizational or regulatory policies" — genuinely more than a simple activity log. This Part builds `AuditEventModel`: a real, hash-chained, tamper-evident, mostly-immutable record, plus a real, deterministic Compliance Engine (Segregation of Duties, Field Change Restriction) evaluated against every stored event.

## Additive, not a replacement — `AuditLogModel` keeps working unchanged
This codebase already has a real `AuditLogModel` (`models/AuditLogmodel.js`), written to by nearly every service across this entire session (`AuditLogModel.create({action, module, resource, resourceId, userId, tenantId, details})`). That IS the "simple activity log" this Part's own Overview explicitly contrasts against a true Audit & Compliance Platform. Rather than retrofitting dozens of existing call sites across the whole codebase — a massive, out-of-scope mechanical refactor with real regression risk — this Part adds a genuinely new, richer capability (`AuditEventModel`, `services/AuditComplianceService.js`) as its own real system. Every existing `AuditLogModel.create()` call site keeps working exactly as before.

## Real hash chaining, enforced at the schema layer
`AuditEventModel.hash` is a real SHA-256 (Node's own `crypto` module, `computeEventHash`) over each event's own evidentiary fields plus the tenant's own real prior event's stored hash (`previousHash`) — a genuine, verifiable chain, not a claimed one. `verifyChainIntegrity` walks the chain ascending, recomputing every hash fresh and comparing it against what's actually stored, reporting the exact break point on a mismatch. Immutability is enforced the same way `LedgerEntryModel` (Part 4) already proved for the General Ledger — pre-save/pre-update hooks that throw — but narrower: only `legalHold`/`status`/`updatedBy` are ever allowed to change after creation, a real, honest lifecycle need (Data Retention/Legal Hold) `LedgerEntryModel`'s own total lock would make impossible to build. The real per-tenant `sequence` comes from a live lookup of the tenant's own last event at write time; the unique `(tenantId, sequence)` index means a concurrent-write race fails loudly on insert rather than silently corrupting the chain — real integrity enforcement, not a fabricated distributed lock.

## Real compliance evaluation, not every category
`services/AuditComplianceService.evaluateCompliancePolicies` (pure, unit-tested) dispatches by a real, tenant-configured `CompliancePolicyModel.ruleType`: `SegregationOfDuties` (the same user both created AND approved a record, read directly from a rich event's own `afterState.createdBy`/`approvedBy`/`approvals[]`) and `FieldChangeRestriction` (a configured field genuinely changed between an event's own `beforeState`/`afterState`). `policyType` (SOX/GDPR/ISO27001/PCIDSS/HIPAA/LocalRegulation/Custom) is a real, tenant-assignable LABEL for a tenant's own categorization/reporting — this module does not implement actual jurisdiction-specific regulatory logic, the same "config-driven label, not a fabricated engine" stance Part 20's Tax Engine already took for real per-country tax law. A `complianceStatus` of `NotEvaluated` (not silently "Compliant") is the honest default when no Active policy applies to an event's category/entityType.

## Real, on-demand Segregation of Duties — only for verified entity shapes
`checkSegregationOfDuties({entityType, entityId})` fetches the ACTUAL live entity and compares its own real `createdBy` against its own real approver field(s) — `approvedBy` (Journal, Invoice, AccountsPayable) or `approvals[].approvedBy` (Expense's own Part 22 ordered multi-approval array). Only these four entity types are wired this pass — their exact field shape was read and verified before writing any dispatch code; any other `entityType` returns a clear "not yet supported" error rather than guessing a field name on an unverified schema. `checkRoleConflicts` scans every real `RoleModel.permissions` array against a real, already-seeded set of conflicting create/approve permission-key pairs (`finance.journal.create`+`finance.journal.approve`, and 12 more — see `utils/financeConfig.js`'s own `sodConflictingPermissionPairs`).

## Investigation reuses a second already-real event source
`getCorrelatedEvents({correlationId})` queries both `AuditEventModel` AND the pre-existing `DomainEventModel` (Part 0's own event-bus outbox, which already has a real `correlationId` field — `utils/eventBus.js`'s `publishEvent` already threads it through from any caller's payload) — a single correlation ID surfaces both the audit trail and the underlying domain events it triggered, genuinely reusing an already-real cross-module event history rather than building a second, parallel one.

## Endpoint Contract: POST/GET /api/v1/audit-events
`POST` (`finance.audit — audit.event.create`): Validate Event → Generate Hash → Store Audit Record → Compliance Validation → Publish `AuditEventStored` (+ `ComplianceViolationDetected`/`PolicyExceptionRaised` where applicable). `GET` (`audit.event.read`, `?module=&category=&entityType=&entityId=&userId=&action=&severity=&complianceStatus=&correlationId=&dateFrom=&dateTo=&page=&pageSize=&sort=`) lists real stored events, newest first by default — this same endpoint is this Part's own "Cross-Module Search."

## Endpoint Contract: Investigation, Integrity, Legal Hold, Evidence Export
`GET /audit-events/investigation/timeline?entityType=&entityId=` (Entity History), `GET /audit-events/investigation/user-activity?userId=` (User Activity), `GET /audit-events/investigation/correlation?correlationId=` (Correlation). `GET /audit-events/verify-integrity` (real chain walk, `?fromSequence=&toSequence=`). `POST /audit-events/:eventId/legal-hold` (`audit.event.manage`, `{legalHold: true|false}`). `POST /audit-events/export` (`audit.event.manage`, real CSV/JSON generation + real storage via the same `storeDocumentPdf` abstraction Part 24's report exports use) — "Chain of Custody" is satisfied by recording the export itself as its own new `AuditEventModel` row (`category: "System"`, `action: "EvidenceExported"`), the audit trail auditing itself.

## Endpoint Contract: Segregation of Duties, Role Conflicts, Compliance Policies
`GET /audit-events/segregation-of-duties/:entityType/:entityId`, `GET /audit-events/role-conflicts`. `POST /compliance-policies` / `GET /compliance-policies` / `POST /compliance-policies/:policyId/status` (all `audit.compliance.manage` for writes, `audit.event.read` for the list).

## Data Retention — real, cron-driven, Legal Hold enforced
`services/auditRetentionScheduler.js` (daily, `AUDIT_RETENTION_CRON_SCHEDULE`) mirrors `financialReportScheduler.js`'s own `runReportExpiry` pattern exactly — one cross-tenant `updateMany` moving `Active` events past their own `expiresAt` to `Archived`, real and simple since every row already carries its own `tenantId`. `legalHold: true` genuinely overrides this — the scheduler's own query excludes any row with it set, regardless of `expiresAt`. Default retention is 2555 days (7 years); 0 disables expiry entirely, same "0 = unconfigured" convention as every other retention-days field this session.

## Domain Events (Part 27 Summary)
`AuditEventStored`, `ComplianceViolationDetected`, `PolicyExceptionRaised`, `EvidenceArchived`, `RetentionExpired`, `IntegrityCheckFailed`. (`InvestigationStarted`/`InvestigationCompleted` from the spec are NOT published as real domain events — Investigation here is a set of real, synchronous read endpoints with no separate stateful "investigation session" concept to start/complete; not fabricated.)

## Deferred / not built this pass
- **Digital Signature** — no real PKI/asymmetric-key management infrastructure exists anywhere in this codebase to build genuine digital signing against; SHA-256 hash chaining (Checksum/Hash Verification/Chain Verification) is real and enforced instead.
- **Secure Deletion** — fundamentally conflicts with this same Part's own "Append-Only Storage"/"Immutable History" AI Coding Rules (deleting a record would also break every subsequent record's own hash chain). Legal Hold + Archived status are the real, honest lifecycle alternative — an honest gap, not a fabricated compliant-looking deletion.
- **Actual jurisdiction-specific SOX/GDPR/ISO27001/PCI-DSS/HIPAA regulatory logic** — `policyType` is a real, tenant-assignable label only; implementing genuine per-jurisdiction regulatory rule engines is beyond what a generic ERP codebase can honestly fabricate, the same stance Part 20's Tax Engine already took for real country-specific tax law.
- **"Approval Conflict"/"Payment Conflict"/"Configuration Conflict" as distinct SoD rule types** — all three collapse into the same two real mechanisms already built (`SegregationOfDuties` creator/approver check, `FieldChangeRestriction`) rather than becoming fabricated rule types with no independent real logic of their own.
- **Encryption at rest** — no field-level encryption is applied to `AuditEventModel`'s own stored content; this codebase's existing MongoDB-level encryption-at-rest posture (infrastructure-level, outside application code) is the real, existing answer, same as every other model in this codebase.
- **"Enterprise Audit & Compliance Platform" / "Enterprise Governance, Risk & Compliance Platform"** — this Part's own two "Principal Software Architect" sections propose dedicated Collector/Compliance/Integrity/Evidence/Investigation/Retention/Reporting engines as separate services, and, above that, a cross-domain GRC platform spanning Risk Management/Policy Management/Identity Governance. Neither was built as a distinct architectural layer — `services/AuditComplianceService.js` already fills the real role directly, and no Risk/Policy/Identity-Governance contract exists anywhere in this codebase to build a shared platform against, same reasoning applied to every prior Part's own speculative-platform proposal.

---

# Part 28 — Enterprise Search & Final Enterprise Finance Architecture

## Overview
The final Part of the Finance module, combining two things: extending the codebase's own already-real, already-shipped Enterprise Search engine to reach Finance data, and a closing, honest retrospective of what the 27 prior Parts actually built.

## An exact-fit precedent found first: `SearchEngineService.js` + `SearchIndexModel.js`
This codebase already runs a real, event-driven, cross-module search engine for the Travel/Visa domain — a real MongoDB text index (`SearchIndexModel`), real boolean/phrase query parsing, a real bounded-Levenshtein fuzzy fallback, real Redis-or-memory result caching, and a real, already-generic `GET /api/v1/search?q=&entityType=&...` endpoint that gates every result by the requester's own `req.auth.permissions` against each indexed row's own `permissionsRequired`. This Part **extends** that engine — 10 new `entityType` values, 10 new real event-driven indexer methods (`indexInvoice`, `indexPayment`, `indexReceipt`, `indexJournal`, `indexGLAccount`, `indexVendor`, `indexExpense`, `indexBankAccountRecord`, `indexAuditEventRecord`, `indexFinancialReport`) — not a second, parallel Finance-specific search system. No new controller and no new routes were needed at all: `GET /search`, `/search/suggestions`, `/search/saved`, `/search/rebuild` were already entity-agnostic.

## Real event names, verified — not guessed
Every one of the ~40 new event subscriptions this Part wires (`InvoiceCreated`/`PaymentCaptured`/`JournalPosted`/`AccountUpdated`/`VendorCreated`/`ExpenseApproved`/`BankAccountActivated`/`AuditEventStored`/`ReportGenerated`/...) was found by grepping each real Part's own service file for its actual `publishEvent(...)` calls and reading the actual payload shape — not assumed from the domain-event lists this doc's own prior Parts named. Two entities have a dual-record lifecycle event (`JournalReversed` carries `originalJournalId`+`reversalJournalId`; `ReceiptReissued` carries `originalReceiptId`+`reissuedReceiptId`) — both records are re-indexed, not just one.

## Reused access control, not a new permission model
Each new indexed entity's `permissionsRequired` is the exact same real permission key that entity's own existing controller already checks for its `GET`/list endpoint (`finance.invoice.read`, `finance.payment.read`, `finance.receipt.read`, `finance.journal.read`, `finance.account.read`, `finance.vendor.read`, `finance.expense.read`, `finance.bankaccount.read`, `audit.event.read`, `finance.report.read`) — verified by grepping each controller's own `hasPermission(...)` calls, not invented. A search result a caller couldn't otherwise `GET` directly never appears in their search results either.

## A real, pre-existing gap fixed in passing
`controllers/EnterpriseSearchController.js`'s `RebuildSearchIndex` handler has always checked `permissions.includes("search.rebuild")`, but that key was never added to the seeded `PermissionModel` catalog `controllers/RoleController.js` validates role-permission assignment against — meaning no tenant admin could ever actually grant it to a custom role, only the hardcoded `"admin"` literal could ever call it. Added now (`utils/authDomainDefaults.js`) as a small, real, in-scope fix — the exact permission the pre-existing code already expected to exist.

## Endpoint Contract — unchanged, now reaching further
`GET /api/v1/search?q=&entityType=Invoice,Payment,...&currency=&category=&complianceStatus=&status=&dateFrom=&dateTo=&page=&pageSize=&sort=` — three new facet filters (`currency`, `category`, `complianceStatus`) were added to both the controller's own query destructuring and `SearchEngineService._computeGlobalSearch`'s existing `facets.*` allowlist, the same mechanism every other facet (`country`, `visaType`, `severity`, ...) already uses. `GET /search/suggestions`, `POST /search/saved`, `GET /search/saved`, `DELETE /search/saved/:id`, `POST /search/rebuild` are all unchanged and now cover Finance entities automatically since `rebuildIndexForTenant` was extended with the same 10 new entity queries.

## Domain Events — real names, some already covered
`EntityIndexed` maps to the pre-existing real `SearchIndexCreated`/`SearchIndexUpdated`/`SearchIndexDeleted` events (`SearchEngineService.indexEntity`/`removeEntity`), unchanged by this Part. `SearchPerformed`, `SuggestionGenerated` (as `SearchSuggestionGenerated`), `SearchSaved` (as `SavedSearchCreated`), and `IndexRebuilt` (as `SearchRebuilt`) were all already real and already published before this Part — this Part's own Finance extension fires through the exact same event names, no new domain events were needed.

## Deferred / not built this pass
- **"Customers"/"Dashboard Widgets"** — Customers are already covered by the existing `Traveler` entityType (Finance's own AR/Invoice reference the SAME `CustomerModel`, not a separate Finance-owned customer record); Dashboard Widgets are honestly NOT indexed — no stored/addable widget-list concept exists anywhere in this codebase (Part 25's own honesty note: a dashboard's widgets are fixed reshaping methods per type, not discrete searchable records).
- **True phonetic matching / a real fuzzy search index / wildcards / nested filters** — `SearchEngineService.js`'s own pre-existing doc comments already name OpenSearch/Elasticsearch as the eventual real answer at scale; the current bounded-Levenshtein-in-JS fallback and regex field match are honest, working approximations, not a fabricated claim of a real search-engine index.
- **Branch Isolation / Branch facet** — dropped entirely per the standing master instructions; tenant is this ERP's only isolation boundary.

---

# Final Enterprise Finance Architecture — an honest retrospective

Twenty-seven prior Parts built a real, working Finance domain inside this one modular-monolith codebase — Chart of Accounts through Audit & Compliance, now reachable through one Enterprise Search index. This closing section grounds the spec's own final architecture diagrams in what was actually shipped, not what was aspirationally proposed.

## The 25 platforms — all real, none independently deployed
Every box in the spec's own "Enterprise Finance Domain" platform map (Chart of Accounts through Enterprise Search) corresponds to a real, working `services/*.js` + `models/*.js` + `controllers/*.js` + `routes/FinanceRoutes.js` grouping in this codebase — genuinely functional, genuinely tested (node's own `--test` runner, 300+ tests by the time this Part shipped). What "platform" does NOT mean here: these are not independently deployable microservices with their own database or network boundary — this is one Express app, one MongoDB connection, one shared `utils/eventBus.js`. "Platform" in this codebase means a cohesive service+model grouping with clear code-level ownership, not a physically isolated deployment unit. Stated honestly rather than overclaimed.

## Platform Communication Principles — real, with one honest caveat
✓ **Owns its data** — real; each Part's own Mongoose models are only ever written to by that Part's own service.
✓ **Exposes APIs** — real; every capability is reachable through `routes/FinanceRoutes.js`, never a direct model import from another domain's controller.
✓ **Publishes Domain Events** — real and extensive; `utils/eventBus.js`'s `publishEvent` is called from nearly every state-changing method across all 27 Parts, durably persisted to `DomainEventModel` when `EVENT_OUTBOX_ENABLED=true`.
✓ **Consumes Domain Events** — real; `KPIEngine` (Part 25), `SearchEngineService` (Part 28), `FinanceAnalyticsEngine` (Part 25) all subscribe to other Parts' own real events rather than polling their tables.
✓ **Maintains clear boundaries** — real at the code level (a service only queries its own models directly; it calls another Part's service method — e.g. `KPIEngine` calling `FinancialReportService.getPeriodMovement` — to reach another domain's data).
⚠ **"Avoids direct database access"** — true as a code-layering *convention* (controllers never import models directly; services own their own models), not as a network-enforced boundary — there is exactly one MongoDB connection shared by the whole process, so this is discipline, not physical isolation.

## Cross-Cutting Concerns — real vs. honestly not built
| Concern | Status |
|---|---|
| Authentication | Real — JWT access/refresh (`authenticateAccessToken`, `utils/authTokens.js`) |
| Authorization / RBAC | Real — `req.auth.permissions` resolved from `RoleModel.permissions`, checked per-endpoint, never a hardcoded role-name allowlist (enforced by `tests/accessScopeRegression.test.js`) |
| Tenant Isolation | Real — `getAccessScope(req)`, the only isolation boundary in this codebase |
| Branch Isolation | **Deliberately NOT implemented** — removed everywhere per the standing master instructions across all 28 Parts |
| Logging | Real — `utils/logger.js` throughout, plus `AuditLogModel`/`AuditEventModel` for access/action trails |
| Caching | Real — `CacheManager` (Redis-or-in-memory), used by Ledger/Search/Dashboard |
| Audit | Real — `AuditLogModel` (activity log, ~30 call sites) + `AuditEventModel` (Part 27's hash-chained, tamper-evident record) |
| Configuration | Real — every Part's own `get*Config()` in `utils/*Config.js`, env-var driven with JSON-parsed fallbacks throughout |
| Observability | Partial — structured logging is real; no unified distributed tracing/metrics/APM (OpenTelemetry or equivalent) is wired anywhere in this codebase |
| Notifications | Partial — a real `NotificationRequested` event signal exists and is published, but only Email actually has a wired delivery adapter (Part 8); SMS/WhatsApp/push are real intents, honestly not implemented end-to-end |
| Localization | **Not implemented** — no i18n/locale system exists anywhere in this codebase |
| Feature Flags | **Not implemented** — no feature-flag system exists anywhere in this codebase |

## Architectural Principles — real vs. honestly not built
| Principle | Status |
|---|---|
| Event-Driven | Real — the primary integration mechanism across all 28 Parts |
| API First | Real — every capability is a REST endpoint under `/api/v1/...` |
| Domain-Driven Design | Real in spirit — `routes → controllers → services → models` layering, one service per bounded context |
| Immutable Accounting Records | Real — `LedgerEntryModel` (Part 4), `FinancialReportModel`/`TaxReportModel` (Parts 20/24), `FinancialAnalyticsModel` (Part 26), `AuditEventModel` (Part 27) all enforce append-only/immutability at the schema layer, not just by convention |
| Scalable Read Models | Real — `FinanceOperationsSummaryModel` (Part 25's persisted daily KPI summary), `FinancialAnalyticsModel` (Part 26's stored analysis runs), `SearchIndexModel` (Part 28) — dashboards/analytics/search never aggregate transactional tables inline on a request |
| Configurable Business Rules | Real and extensive — `utils/financeConfig.js` alone is 1,200+ lines of env-var-overridable, JSON-fallback config spanning all 27 Finance Parts |
| ⚠ CQRS (where beneficial) | Real only informally — the read-optimized models above ARE a genuine write/read separation, but there is one shared MongoDB database, not physically separate write/read stores or a dedicated command/query bus; "where beneficial" was applied selectively (Dashboard/Analytics/Search), not universally |
| ⚠ Platform Isolation | See "The 25 platforms" section above — code-level ownership is real, physical deployment isolation is not |
| ⚠ Idempotent APIs | **Honestly NOT built** — a real `IdempotencyKeyModel` exists in this codebase, but grep confirms zero Finance services actually use it; none of the 27 Finance Parts' own write endpoints are idempotency-key-protected against duplicate submission. A real, named gap, not silently claimed as done |
| ⚠ Versioned Contracts | Partial — every route lives under a single `/api/v1/` prefix, but no formal deprecation/versioning policy beyond that one prefix exists |

## Deferred / not built this pass
- **Physical platform isolation (microservices, per-platform databases, a real API Gateway)** — this remains, by design, one modular monolith; splitting it into independently deployable services was never in scope for any of the 28 Parts and isn't proposed here either.
- **Idempotent APIs** — the most concrete, actionable gap this retrospective surfaced; `IdempotencyKeyModel` already exists and is unused by Finance — a real, scoped follow-up for a future pass, not fabricated as already handled.
- **Localization, Feature Flags, unified Observability/APM** — no infrastructure for any of the three exists anywhere in this codebase today; honestly named rather than silently assumed.
- **"Enterprise Governance, Risk & Compliance Platform" and every other cross-domain platform proposal from the spec's own "Principal Software Architect Recommendations" across all 28 Parts** — consistently not built as a distinct architectural layer, for the same reason each time: no concrete endpoint contract for the proposed cross-domain platform exists anywhere in this codebase to build against, and the real capability it would provide is already reachable through the Part that actually shipped.

---

# Progress

07-finance-api.md

- [x] Module Foundation
- [x] Chart of Accounts
- [x] General Journal
- [x] General Ledger
- [x] Accounts Receivable
- [x] Accounts Payable
- [x] Payments
- [x] Receipts
- [x] Invoices
- [x] Credit Notes
- [x] Debit Notes
- [x] Refund Management
- [x] Bank Accounts
- [x] Bank Reconciliation
- [x] Cash Management
- [x] Expenses
- [x] Vendor Payments (Part 17 — a real orchestration layer above Part 7's Payment Engine; see Part 17's own "A note on the Progress checklist")
- [x] Customer Payments (Part 18 — a real orchestration layer above Part 5's AR + Part 7's Payment Engine, the mirror-image of Part 17 on the AR side)
- [x] Multi-Currency & Foreign Exchange (Part 19 — shared Conversion/Revaluation Engine; reads live balances off Bank Account/AR/AP with zero schema changes to any of them)
- [x] Tax Engine (Part 20 — real versioned/effective-dated TaxRuleModel; replaces Invoice/Credit Note/Debit Note's own static tax-code lookup, not a parallel system)
- [x] Discount & Pricing Engine (Part 21 — real versioned/effective-dated PricingRuleModel; replaces Invoice's own static per-line discount fields' source, not a parallel system; reuses Part 20's TaxService for the final tax step)
- [x] Financial Approval Workflow (Part 22 — real versioned multi-level/parallel/conditional engine, distinct from the existing Booking/Visa `WorkflowEngine.js`; one proven integration into ExpenseService, other ~14 existing single-gate approvals explicitly left as-is)
- [x] Settlement Engine (Part 23 — real fee/net calculation and batching on top of the existing Payment Engine; finally gives Part 7's own long-listed-but-never-set 'Settled' payment status its first real setter)
- [x] Financial Reports (Part 24 — thin real aggregation layer over already-immutable sources: LedgerService's own trial balance/ledger, JournalService, TaxService, AR/AP aging, ExpenseBudgetModel; never recalculates a business transaction)
- [x] Financial Dashboard (Part 25 — extends `KPIEngine.js` with `computeFinanceMetrics`/`refreshFinanceSummary`/`buildFinanceAlerts` rather than a parallel system, mirroring Visa's own proven `VisaAnalyticsEngine`/`VisaDashboardController` persisted-summary + cache + background-refresh architecture; real deterministic threshold alerts, no ML)
- [x] Financial Analytics (Part 26 — real linear-regression trend/forecast and z-score anomaly detection sampled from Part 4/24's own immutable, arbitrarily-historical GL sources, never dependent on Part 25's shallow same-day summary table; Executive Insights reuses the already-wired AIModelRouterService; Product/Department/Country Profitability and true ML honestly deferred — no backing dimension/library exists to build them against)
- [x] Audit & Compliance (Part 27 — additive `AuditEventModel`: real SHA-256 hash-chained, tamper-evident, mostly-immutable via guarded pre-hooks the same `LedgerEntryModel` technique already proved; real deterministic Segregation-of-Duties/Field-Change-Restriction compliance evaluation, no ML; every existing `AuditLogModel` call site keeps working unchanged)
- [x] Enterprise Search (Part 28 — extends the pre-existing, real `SearchEngineService`/`SearchIndexModel` Travel/Visa search engine with 10 new Finance entityTypes and ~40 verified real event subscriptions, rather than a parallel Finance-specific search system; reuses each entity's own existing `finance.*.read`/`audit.event.read` permission for result-level access control; fixed a real, pre-existing `search.rebuild` permission-catalog gap found along the way)
- [x] Final Enterprise Architecture (Part 28 — an honest retrospective grounding every spec claim in what was actually shipped across all 27 prior Parts; names Idempotent APIs as the most concrete real gap, `IdempotencyKeyModel` exists but is unused by any Finance service; "platform" means code-level ownership within one modular monolith, not independently deployed microservices)

Progress: **100%** — `docs/05-api/07-finance-api.md` is complete. All 28 Parts of the Finance module have shipped: Chart of Accounts through Enterprise Search, one coherent, tenant-isolated, RBAC-gated, event-driven domain inside this codebase.
