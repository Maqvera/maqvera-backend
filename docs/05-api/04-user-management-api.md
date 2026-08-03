---
title: User Management API
document_id: API-004
version: 1.0.0
status: Complete
module: User Management
---

# User Management API

---

# Part 1 — Module Foundation

# 1. Overview

The User Management module is responsible for managing employees, administrators, managers, agents, accountants, visa officers, support staff, and every internal user of the platform.

Unlike the Identity module, this module does NOT authenticate users. Instead, it manages organizational workforce users after their identity has already been established or during account onboarding.

```
Identity  ──►  Who are you?
                  │
User Mgmt ──►  What organization do you belong to?
                  │
          ──►  What role do you have?
                  │
          ──►  Which branch & department do you work in?
                  │
          ──►  What permissions do you have?
```

---

# 2. Business Purpose

The User Management module enables organizations to manage their workforce cleanly and securely.

---

# Part 2 — User CRUD APIs

## GET /api/v1/users
Returns a paginated list of employees belonging to the authenticated tenant.

## POST /api/v1/users
Creates a new employee inside the organization.

## GET /api/v1/users/{userId}
Returns the complete profile of one employee.

---

# Part 3 — User Update, Status, Role & Assignment APIs

---

## Endpoint Contract: PATCH /api/v1/users/{userId}

### 36. Business Purpose
Updates an existing employee profile. Modifies business information only (does NOT modify passwords, credentials, sessions, or MFA).

### 38. Editable Fields
- **Allowed:** First Name, Last Name, Phone, Designation, Emergency Contact, Address, Preferred Language, Profile Picture, Timezone, Notes
- **Not Allowed:** Password, Email (dedicated endpoint), Employee Code, Tenant ID, Created At, Identity ID

### 41. Successful Response (200 OK)
```json
{
  "success": true,
  "message": "User updated successfully.",
  "data": {
    "userId": "64f1a2..."
  }
}
```

---

## Endpoint Contract: PATCH /api/v1/users/{userId}/status

### Business Purpose
Changes an employee's employment status across the controlled lifecycle:
`Pending Invitation` ──► `Active` ──► `Suspended` ──► `Inactive` ──► `Archived`

### Request Payload
```json
{
  "status": "Suspended",
  "reason": "Policy violation"
}
```

### Business Rules
- Archived users cannot become Active directly.
- Suspended users cannot log in.
- Active users may access the system.
- Status history is preserved in `EmploymentHistoryModel`.

---

## Endpoint Contract: PATCH /api/v1/users/{userId}/branch

### Business Purpose
Transfers an employee between branches within the same tenant.

### Request Payload
```json
{
  "branchId": "KARACHI"
}
```

---

## Endpoint Contract: PATCH /api/v1/users/{userId}/department

### Business Purpose
Moves an employee to another department (Sales, Visa, Finance, HR, Support, Marketing, Administration, Development).

---

## Endpoint Contract: PATCH /api/v1/users/{userId}/roles

### Business Purpose
Assigns one or multiple roles to an employee. Invalidates permission cache.

```json
{
  "roleIds": ["64f1d5...", "64f1e6..."]
}
```

---

## Endpoint Contract: PATCH /api/v1/users/{userId}/permission-overrides

### Business Purpose
Adds explicit exceptions to inherited role permissions.

```json
{
  "grant": ["finance.export"],
  "revoke": ["booking.delete"]
}
```

---

## Endpoint Contract: GET /api/v1/users/{userId}/permissions

### Purpose
Returns calculated effective permissions:

$$\text{Effective Permissions} = \text{Role Permissions} + \text{Granted Overrides} - \text{Revoked Overrides}$$

```json
{
  "permissions": [
    "booking.read",
    "booking.create",
    "customer.read",
    "finance.invoice.create"
  ]
}
```

---

## Onboarding & Invitations

- `POST /api/v1/users/invite` — Invites a new employee and queues invitation token email.
- `POST /api/v1/users/{userId}/resend-invitation` — Regenerates and resends invitation token.
- `POST /api/v1/users/{userId}/accept-invitation` — Onboards employee with username/password.

---

## Employment History

### GET /api/v1/users/{userId}/employment-history
Returns complete employment timeline (Joined, Promoted, Transferred, Department Changed, Role Updated, Archived).

---

## User Preferences

- `GET /api/v1/users/{userId}/preferences`
- `PATCH /api/v1/users/{userId}/preferences`

Stores user-specific preferences: Language, Timezone, Theme, Dashboard Layout, Notification Preferences, Date Format, Currency Format.

---

# Final User Management Architecture

```
User Management
│
├── Employee Profiles
│
├── Organization
│   ├── Branch Assignment
│   ├── Department Assignment
│   └── Reporting Structure
│
├── Access
│   ├── Roles
│   ├── Permission Overrides
│   └── Effective Permissions
│
├── Employment
│   ├── Status
│   ├── Transfers
│   ├── Promotions
│   ├── Employment History
│   └── Archive
│
├── Invitations
│   ├── Invite
│   ├── Resend
│   └── Accept
│
└── Preferences
    ├── Language
    ├── Timezone
    ├── Theme
    └── Notifications
```

---

# User Management Module Status

✅ **COMPLETE**  
**Document ID:** API-004  
**Version:** 1.0.0
