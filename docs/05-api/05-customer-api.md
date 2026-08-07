---
title: Customer Management API
document_id: API-005
version: 1.0.0
status: Approved
module: Customer Management
---

# Customer Management API

---

# Part 1 — Module Foundation

# 1. Overview

The Customer Management module is responsible for managing every customer, traveler, pilgrim, organization, and related contact within the platform.

This module acts as the **Customer Master Repository**.

```
Booking ──► Customer ID
Visa    ──► Customer ID
Finance ──► Customer ID
Docs    ──► Customer ID
AI/CRM  ──► Customer ID
```

---

# 2. Customer vs Traveler Distinction

```
Customer (Account Owner / Payer)
   │
   └── Contacts, Addresses, Notes, Payments, Loyalty, Timeline
         │
         ▼
Traveler (Person Traveling)
   │
   └── Passports, Visa History, Medical Info, Emergency Contacts, Mahram Info, Travel Preferences
```

---

# Part 2 — Customer CRUD APIs

- `GET /api/v1/customers` — Paginated list & search
- `POST /api/v1/customers` — Creation with duplicate detection
- `GET /api/v1/customers/{customerId}` — Full profile view

## Access Scope (Company + Branch Isolation)

Every one of the CRUD endpoints above (`ListCustomers`, `SearchCustomers`, `CreateCustomer`, `GetCustomer`, `UpdateCustomer`, `ArchiveCustomer`) is filtered through `getAccessScope(req)` (`utils/accessScope.js`), derived from the caller's Role (`models/Rolemodel.js`, `scope: "branch" | "tenant"`):

- **`scope: "branch"` (default)** — the caller only sees/acts on customers in their own `branchId`, within their own tenant. `GET /customers?branchId=...` can never widen this — a branch-scoped caller's own branch always wins over the query param.
- **`scope: "tenant"`** — the caller sees/acts on every branch within their own tenant (never another tenant). `?branchId=` may be used to narrow to one branch.
- **`POST /customers`** mirrors this on the write side: a branch-scoped caller cannot create a customer under a different branch by naming it in the request body (`403`) — the new customer is always created in the caller's own branch. A tenant-scoped caller may specify any active branch within their tenant.

Sub-resource endpoints under `/customers/{customerId}/...` (documents, notes, family, passports, phones, emails, addresses, preferences, emergency contacts) currently enforce tenant isolation only (`{ _id: customerId, tenantId }`) — branch-level enforcement has not yet been extended to them.

---

# Part 3 — Customer Profile Management APIs

---

## Endpoint Contract: PATCH /api/v1/customers/{customerId}

### 36. Business Purpose
Updates an existing customer profile (business information only). Does NOT update password, bookings, or visas.

### 38. Editable Fields
- **Personal:** First Name, Last Name, Middle Name, Gender, Date of Birth, Marital Status
- **Contact:** Phone, Alternate Phone, Email, Address
- **Business:** Customer Category, Customer Type, Assigned Consultant, Preferred Language, Preferred Currency, Marketing Consent, Notes, Profile Photo
- **Non-Editable:** Customer Code, Tenant ID, Created Date, Created By, Identity ID

### 41. Successful Response (200 OK)
```json
{
  "success": true,
  "message": "Customer updated successfully.",
  "data": {
    "customerId": "64f2a1..."
  }
}
```

---

## Endpoint Contract: POST /api/v1/customers/{customerId}/archive

### Business Purpose
Archives a customer profile instead of hard deleting to preserve referential integrity across bookings, invoices, and audit logs.

### Response (200 OK)
```json
{
  "success": true,
  "message": "Customer archived."
}
```

---

## Endpoint Contract: GET /api/v1/customers/search

### Business Purpose
Provides enterprise-level fast lookup (<200ms) for Booking Wizard, Visa Wizard, and Global Search.

**Search Fields:** Customer Code, Passport Number, National ID, Phone, Email, Full Name, Company Name, Tags.

---

## Endpoint Contract: POST /api/v1/customers/merge

### Business Purpose
Merges duplicate customer records into a primary surviving profile.

```json
{
  "primaryCustomerId": "64f2a1...",
  "duplicateCustomerId": "64f2b2..."
}
```

Transfers bookings, visas, payments, documents, notes, family members, and timeline entries to the surviving customer before archiving the duplicate.

---

# Duplicate Detection Scoring

- **Passport Number:** 100%
- **National ID:** 100%
- **Phone / Email:** 95%
- **Same Name + DOB:** 90%
- **Same Name + Phone:** 85%

---

# Customer Profile Completeness & Health Score

### Completeness Score (0 - 100%):
- Personal Info (20%)
- Contact Info (20%)
- Passport (15%)
- Emergency Contact (10%)
- Documents (10%)
- Travel Preferences (10%)
- Marketing Preferences (5%)
- Family Information (5%)
- Profile Photo (5%)

### Health Score Ratings:
- **80 - 100%:** Excellent
- **60 - 79%:** Good
- **40 - 59%:** Average
- **0 - 39%:** Poor

---

# Customer Profile Versioning

Stores a historical version snapshot (`versions` array) whenever critical profile details are modified, preserving complete audit trails and enabling historical restoration.

`GET /api/v1/customers/{customerId}/versions`

---

# Progress Summary

- [x] Module Foundation
- [x] GET /api/v1/customers
- [x] POST /api/v1/customers
- [x] GET /api/v1/customers/{customerId}
- [x] PATCH /api/v1/customers/{customerId}
- [x] Archive Customer (`POST /customers/{id}/archive`)
- [x] Customer Search (`GET /customers/search`)
- [x] Customer Merge (`POST /customers/merge`)
- [x] Profile Completeness & Health Score Calculation
- [x] Customer Profile Versioning History
- [x] Family Members, Passports, Documents, Notes, Timeline, Preferences & Statistics Management

✅ **COMPLETE**  
**Document ID:** API-005  
**Version:** 1.0.0
