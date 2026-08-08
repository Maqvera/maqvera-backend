---
title: Booking Management API Specification
document_id: API-006
version: 1.0.0
status: Complete
module: Booking Management
---

# Booking Management API Specification

---

# Part 1 — Module Foundation

## 1. Overview
The Booking module is the operational heart of the Travel ERP. A booking represents a customer's purchase of one or more travel services (Umrah Package, Hajj Package, Tours, Flights, Hotels, Visas, etc.). Every operational module eventually connects to a booking.

---

## 2. Business Purpose
The Booking module coordinates the complete customer journey:
Customer ──► Quotation ──► Booking ──► Travel Services ──► Visa ──► Payments ──► Documents ──► Travel ──► Completion ──► Reporting

---

## 3. Module Responsibilities
Responsible For:
✓ Booking Creation & Header Management
✓ Traveler Assignment & Customer Snapshots
✓ Generic Service Assignments (Flights, Hotels, Visas, Transport, etc.)
✓ Configurable Workflow Engine State Machine
✓ Read-Only Financial Snapshots
✓ Documents, Notes, Timeline, and Task Management
✓ Operational Dashboards & Enterprise Search
✓ Domain Event Emission

Not Responsible For:
✗ Master Customer Profile Management
✗ Authentication & Identity Provider
✗ General Ledger & Double-Entry Accounting
✗ Direct Visa Embassy Processing Engine

---

## 4. Booking Lifecycle
Draft ──► Quotation ──► Reserved ──► Confirmed ──► Deposit Received ──► Visa Processing ──► Ticket Issued ──► Travel Ready ──► Traveling ──► Completed

Possible Exceptions: Cancelled, Refund Requested, Refund Completed, Archived.

---

## 5. Booking Aggregate Structure
Booking Aggregate (Aggregate Root)
│
├── Booking Header (`booking_headers`)
├── Financial Snapshot (`financial_snapshot`)
├── Customer Snapshot (`customer_snapshot`)
├── Traveler Snapshots (`booking_travelers`)
├── Service Assignments (`booking_services`)
├── Traveler Service Assignments (`traveler_service_assignments`)
├── Service Templates Catalog (`service_templates`)
├── Workflow Instance (`workflow_instances`)
├── Documents (`booking_documents` - Generic Document Service)
├── Notes (`booking_notes` - Generic Notes Service)
├── Timeline (`booking_timeline` - Generic Timeline Service)
├── Tasks (`booking_tasks` - Generic Task Service)
└── Audit Log (`audit_logs`)

---

# Part 2 — Booking CRUD APIs

- `GET /api/v1/bookings` — Returns paginated, tenant-isolated list of bookings.
- `POST /api/v1/bookings` — Creates Booking Header, Financial Snapshot, Workflow, and Timeline.
- `GET /api/v1/bookings/{bookingId}` — Returns full Booking Aggregate Summary.
- `PATCH /api/v1/bookings/{bookingId}` — Updates editable header fields (`travelDate`, `assignedConsultant`, `remarks`, `priority`, etc.).
- `POST /api/v1/bookings/{bookingId}/archive` — Soft deletes booking (preserves audit and reporting history).

---

# Part 3 — Booking Travelers APIs

- `GET /api/v1/bookings/{bookingId}/travelers` — Returns assigned travelers with Customer Snapshots.
- `POST /api/v1/bookings/{bookingId}/travelers` — Adds travelers, generates Customer Snapshots, enforces single primary traveler.
- `PATCH /api/v1/bookings/{bookingId}/travelers/{travelerId}` — Updates traveler-specific preferences/assignments (does NOT mutate master customer profile).
- `DELETE /api/v1/bookings/{bookingId}/travelers/{travelerId}` — Soft deletes traveler and releases assigned services.

---

# Part 4 — Booking Services APIs

- `GET /api/v1/bookings/{bookingId}/services` — Returns generic service registry items for a booking.
- `POST /api/v1/bookings/{bookingId}/services` — Assigns services, auto-recalculates Financial Snapshot.
- `PATCH /api/v1/bookings/{bookingId}/services/{serviceAssignmentId}` — Updates service details/prices, triggers financial recalculation.
- `DELETE /api/v1/bookings/{bookingId}/services/{serviceAssignmentId}` — Soft deletes service assignment, recalculates financials.
- `POST /api/v1/bookings/{bookingId}/traveler-services` — Connects individual travelers to specific services (`traveler_service_assignments`).

---

# Part 5 — Booking Workflow APIs

- `GET /api/v1/bookings/{bookingId}/workflow` — Returns workflow instance, current step, allowed next actions, pending approvals, and history.
- `PATCH /api/v1/bookings/{bookingId}/workflow` — Executes transition via State Machine, validates user roles & permissions, triggers auto-actions.

---

# Part 6 — Booking Operations APIs

- `POST /api/v1/bookings/{bookingId}/cancel` — Executes controlled cancellation workflow, requires mandatory reason/category, triggers refund requests.
- `GET` & `POST /api/v1/bookings/{bookingId}/documents` — Registers and retrieves document metadata.
- `GET` & `POST /api/v1/bookings/{bookingId}/notes` — Adds and lists operational notes with visibility controls.
- `GET /api/v1/bookings/{bookingId}/timeline` — Immutable chronological feed of operational events.
- `GET` & `POST /api/v1/bookings/{bookingId}/tasks` — Linked task management and assignments.

---

# Part 7 — Financial Summary, Search & Final Architecture

---

## Booking Financial Summary

### Overview
The Booking module exposes a read-only financial summary based on the **Financial Snapshot** read model.
The Finance module remains the source of truth, while the Booking module maintains an optimized read model for ultra-fast UI rendering and reporting.

---

### Endpoint Contract: GET /api/v1/bookings/{bookingId}/financial-summary

#### Business Purpose
Returns a summarized financial view of the booking for Booking Details, Customer Portal, Operations, and Finance Dashboards.

---

#### Successful Response (200 OK)
```json
{
  "success": true,
  "data": {
    "bookingTotal": 850000,
    "packageTotal": 850000,
    "serviceCharges": 5000,
    "taxes": 0,
    "discounts": 25000,
    "netAmount": 830000,
    "paidAmount": 400000,
    "outstandingAmount": 430000,
    "refundAmount": 0,
    "currency": "USD",
    "paymentStatus": "Partially Paid",
    "lastPaymentDate": "2026-10-01T12:00:00Z",
    "nextDueDate": "2026-10-10T00:00:00Z",
    "invoiceCount": 1,
    "paymentCount": 2,
    "lastUpdated": "2026-10-01T12:00:00Z"
  }
}
```

---

#### AI Coding Rules
- ✓ Read Model Only
- ✓ Never calculate directly from raw payments table on every GET request
- ✓ Cache aggressively in Redis
- ✓ Refresh asynchronously upon finance domain events

---

## Booking Search

### Overview
Provides enterprise multi-field search across bookings for CRM, Operations, Finance, Visa, and AI Assistant.

---

### Endpoint Contract: GET /api/v1/bookings/search

#### Search Fields Supported
Booking Number, Customer Name, Passport Number, Phone Number, Email, Invoice Number, Visa Number, Ticket Number, Hotel Voucher, Package Name, Assigned Consultant, Supplier, Reference Number, Remarks.

---

#### Search Filters
`bookingStatus`, `paymentStatus`, `visaStatus`, `workflowState`, `travelDateFrom`, `travelDateTo`, `consultantId`, `supplierId`, `packageId`, `bookingType`.

---

## Booking Dashboard API

### Endpoint Contract: GET /api/v1/bookings/dashboard

#### Business Purpose
Returns real-time operational dashboard widgets and analytics metrics.

---

#### Response Includes
- `todaysBookingsCount`
- `upcomingDeparturesCount`
- `pendingPaymentsTotal`
- `pendingVisaCount`
- `cancelledBookingsCount`
- `grossRevenue`
- `outstandingBalanceTotal`
- `taskSummary` (Created, Pending, Completed, Overdue)
- `workflowSummary` (Counts per workflow state)
- `bookingTrends` (Monthly/Weekly growth metrics)

---

# Domain Events Catalog

- `BookingCreated`
- `BookingUpdated`
- `BookingArchived`
- `BookingCancelled`
- `TravelerAdded`
- `TravelerRemoved`
- `TravelerUpdated`
- `BookingServiceAssigned`
- `BookingServiceUpdated`
- `BookingServiceRemoved`
- `WorkflowTransitionCompleted`
- `BookingConfirmed`
- `BookingCompleted`
- `BookingDocumentUploaded`
- `BookingNoteCreated`
- `BookingTaskCreated`
- `BookingTaskCompleted`
- `BookingFinancialUpdated`
- `BookingAnalyticsUpdated`

---

# Module Dependencies

```
Booking Module
  ↓
Customer Module ──► Package Module ──► Finance Module ──► Visa Module
  ↓
Workflow Engine ──► Generic Platform Services (Document, Task, Note, Timeline, Notification)
  ↓
Infrastructure Layer (Redis ──► MongoDB / PostgreSQL ──► Object Storage)
```

---

# 🏛️ Senior Architect Review: Booking Saga (Process Manager)

Complex booking operations span multiple modules and cannot be executed in a single database lock. We introduce a **Booking Saga (Process Manager)**:

```
Customer Creates Booking
        │
        ▼
Booking Created
        │
        ├────────► Create Workflow Instance
        ├────────► Create Financial Snapshot
        ├────────► Assign Default Tasks
        ├────────► Notify Consultant & Customer
        ├────────► Create Timeline Event
        ├────────► Reserve Inventory / Services
        ├────────► Generate Initial Invoice
        └────────► Publish Analytics Event
```

### Why a Saga?
- Prevents tightly coupled synchronous calls between modules.
- Handles failures gracefully using compensation actions (e.g. if invoice generation fails, reserve inventory is released).
- Enables asynchronous, event-driven architecture with complete process observability.

---

# Performance & Security Rules

### Performance Strategy
- Cursor & Offset Pagination
- Composite DB Indexes on (`tenantId`, `status`, `createdAt`)
- Redis Caching for Read Models & Dashboards
- Async Domain Event Processing

### Security Rules
- Strict Multi-Tenant Isolation
- Role-Based Access Control (`bookings.read`, `bookings.create`, `bookings.update`, `bookings.delete`)
- Comprehensive Audit Logging (`AuditLogModel`)
- Soft Delete only (No permanent row deletion)
- Sensitive Data Masking & JWT Validation

---

# Booking Module Completion Checklist

- Core Features: CRUD ✅, Travelers ✅, Services ✅, Workflow Engine ✅, Cancellation ✅, Documents ✅, Notes ✅, Timeline ✅, Tasks ✅, Financial Summary ✅, Dashboard ✅
- Architecture: Multi-Tenant ✅, Event Driven ✅, Aggregate Root ✅, CQRS Ready ✅, Read Models ✅, Saga Process Manager ✅
- Security & Compliance: JWT ✅, RBAC ✅, Tenant Isolation ✅, Audit Logging ✅

---

**Booking Module Status**: ✅ **COMPLETE**
**Document ID**: API-006
**Version**: 1.0.0
**Next Specification**: API-007 — Travel Operations API
