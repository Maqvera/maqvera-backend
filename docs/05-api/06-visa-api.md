---
title: Visa Management API
document_id: API-006
version: 1.0.0
status: Draft
module: Visa Management
---

# Visa Management API

## Overview

The Visa Management module is responsible for managing the complete lifecycle of visa applications for travelers.

It provides a centralized platform for handling visa requirements, document collection, verification, embassy processing, appointments, passport tracking, approvals, and post-processing activities.

The module supports multiple countries, multiple embassies, multiple visa types, and multiple tenants.

The system is designed for travel agencies, Umrah operators, Hajj operators, tourism companies, corporate travel departments, and immigration consultants.

---

# Module Responsibilities

The Visa Management module is responsible for:

✓ Visa Applications

✓ Visa Requirements

✓ Country Rules

✓ Eligibility Validation

✓ Required Documents

✓ Document Collection

✓ Document Verification

✓ OCR Integration

✓ Embassy Submission

✓ Passport Tracking

✓ Visa Status Management

✓ Biometrics

✓ Medical Appointments

✓ Embassy Interviews

✓ Visa Incidents

✓ Notes

✓ Timeline

✓ Attachments

✓ Dashboard

✓ Reporting

✓ Search

✓ AI Recommendations

---

# Not Responsible For

The Visa module DOES NOT manage:

✗ Customer Registration

✗ Booking Creation

✗ Hotel Booking

✗ Flight Reservation

✗ Accounting

✗ Authentication

✗ Notifications

These belong to their own bounded contexts.

---

# Visa Domain

Customer

↓

Traveler

↓

Visa Case

↓

Visa Application

↓

Documents

↓

Embassy Processing

↓

Visa Decision

↓

Travel Ready

Every traveler may have multiple visa cases over time.

---

# Core Aggregate

Visa Case

The Visa Case is the Aggregate Root.

Everything belongs to the Visa Case.

Examples

Visa Application

Required Documents

Passport

Embassy Submission

Appointments

Timeline

Notes

Incidents

Attachments

Workflow

Nothing modifies child entities directly.

Everything goes through the Visa Case Aggregate.

---

# Visa Lifecycle

Inquiry

↓

Eligibility Check

↓

Application Draft

↓

Documents Pending

↓

Documents Verified

↓

Ready For Submission

↓

Submitted To Embassy

↓

Embassy Processing

↓

Additional Documents Required

↓

Interview Scheduled

↓

Medical Scheduled

↓

Visa Approved

↓

Visa Printed

↓

Passport Collected

↓

Travel Ready

Alternative Paths

↓

Rejected

Cancelled

Expired

Withdrawn

Blacklisted

Workflow configurable.

---

# Multi-Tenant Strategy

Every Visa Case contains:

tenant_id

Every query automatically filters by tenant.

No cross-tenant access.

---

# Multi-Branch Strategy

Operational ownership uses:

branch_id

Examples

Visa Case

Document Collection

Embassy Submission

Appointments

Incidents

Dashboard

Each branch operates independently.

---

# Country Support

Supported through master tables.

Countries

Cities

Embassies

Visa Types

Currencies

Languages

Requirements

No country names hardcoded.

---

# Supported Visa Types

Tourist Visa

Business Visa

Visit Visa

Umrah Visa

Hajj Visa

Work Visa

Student Visa

Medical Visa

Transit Visa

Family Visa

Diplomatic Visa

Custom

Visa types configurable.

---

# High Level Architecture

Customer

↓

Traveler

↓

Visa Case

↓

Application

↓

Documents

↓

Verification

↓

Embassy

↓

Appointments

↓

Decision

↓

Passport Collection

↓

Travel Ready

---

# Enterprise Design Principles

✓ Domain Driven Design

✓ Clean Architecture

✓ CQRS Ready

✓ Event Driven

✓ Multi-Tenant

✓ Multi-Branch

✓ Workflow Driven

✓ Configurable Statuses

✓ AI Ready

✓ Object Storage

✓ Audit Logging

✓ Timeline

✓ Soft Delete

---

# Domain Events

VisaCaseCreated

VisaApplicationCreated

DocumentUploaded

DocumentVerified

EmbassySubmissionCreated

AppointmentScheduled

InterviewCompleted

MedicalCompleted

VisaApproved

VisaRejected

PassportCollected

VisaCompleted

Every business action generates a domain event.

---

# AI Coding Rules

✓ Never hardcode embassy workflows.

✓ Never hardcode visa statuses.

✓ Never hardcode required documents.

✓ Never hardcode eligibility rules.

✓ Store attachments in Object Storage.

✓ Keep PostgreSQL for metadata only.

✓ Every operation generates timeline events.

✓ Every operation generates audit logs.

✓ Every workflow configurable.

✓ Every endpoint tenant aware.

---

Implementation Status

Module Foundation

Status

✅ Complete

Next Section

Visa Application APIs

---

🏛 Senior Architect Improvement (Highly Recommended)

Instead of designing the system around a single Visa Application, design it around a Visa Case.

Traveler
     │
     ▼
Visa Case
     │
     ├── Application #1
     ├── Embassy Submission #1
     ├── Additional Documents
     ├── Interview
     ├── Rejection
     │
     ├── Reapplication
     │
     ├── Application #2
     ├── Embassy Submission #2
     ├── Approval
     └── Passport Collection

Why this is better

A traveler's visa journey is rarely linear. They may:

Be asked for additional documents.
Be rejected and reapply.
Change visa types.
Transfer to another embassy.
Appeal a decision.

By making Visa Case the Aggregate Root, you preserve the complete history of the traveler's visa journey, avoid fragmented records, and provide AI coding agents with a stable domain model that can evolve without redesigning the database.

# Part 2 — Visa Application CRUD APIs

## Overview

The Visa Application APIs manage the creation, retrieval, update, and lifecycle of visa applications within a Visa Case.

A Visa Case may contain one or more Visa Applications.

Examples:
• Initial Application
• Re-Application
• Appeal Application
• Renewal Application
• Visa Extension

Each application has its own workflow while remaining part of the same Visa Case.

---

# Application Architecture

Traveler
↓
Visa Case
↓
Visa Application
↓
Requirements
↓
Documents
↓
Verification
↓
Embassy Submission
↓
Decision

---

# Application Lifecycle

Draft
↓
Requirements Generated
↓
Documents Pending
↓
Documents Submitted
↓
Documents Verified
↓
Ready For Submission
↓
Submitted
↓
Processing
↓
Decision Received
↓
Completed

Alternative Paths:
Rejected | Withdrawn | Cancelled | Expired

Workflow configurable.

---

# Endpoint Contract: GET /api/v1/visa-cases

## Business Purpose
Returns Visa Cases visible to the authenticated tenant.

## Query Parameters
- `page`
- `pageSize`
- `status`
- `countryId` (or `destinationCountry`)
- `visaTypeId` (or `visaType`)
- `branchId`
- `travelerId`
- `assignedTo`
- `createdFrom`
- `createdTo`

## Response Includes
- Visa Case ID
- Case Number
- Traveler
- Destination Country
- Visa Type
- Current Status
- Assigned Officer
- Created Date
- Last Updated
- Priority

## Business Rules
- Tenant Isolation
- Branch Isolation
- Pagination
- Filtering
- Sorting

---

# Endpoint Contract: POST /api/v1/visa-cases

## Business Purpose
Creates a new Visa Case.

## Request Example
```json
{
  "travelerId": "UUID",
  "countryId": "Saudi Arabia",
  "visaTypeId": "Umrah",
  "travelPurpose": "Umrah",
  "plannedTravelDate": "2027-02-15",
  "priority": "Normal"
}
```

## Business Workflow
Validate Traveler
↓
Validate Country
↓
Validate Visa Type
↓
Generate Case Number
↓
Create Visa Case
↓
Create Initial Visa Application
↓
Generate Requirements
↓
Initialize Workflow
↓
Create Timeline
↓
Audit
↓
Publish VisaCaseCreated
↓
Return Success

## Validation Rules
- Traveler Exists
- Traveler Active
- Country Exists
- Visa Type Exists
- No Duplicate Active Case
- Tenant Match
- Branch Match

## Business Rules
- One traveler may have multiple historical cases.
- Only one active case for the same country and visa type.
- Case Number auto-generated (VIS-2027-000001 format).
- Workflow initialized automatically.

## Domain Events
- `VisaCaseCreated`
- `VisaApplicationInitialized`
- `RequirementsGenerated`

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}

## Business Purpose
Returns complete Visa Case details.

## Response Includes
- Case Information
- Traveler
- Application
- Required Documents
- Uploaded Documents
- Verification Status
- Embassy Status
- Appointments
- Timeline
- Notes
- Incidents
- Attachments
- Audit Summary

## Business Rules
- Aggregate View
- Read-only
- Supports lazy loading

---

# Endpoint Contract: PATCH /api/v1/visa-cases/{visaCaseId}

## Business Purpose
Updates Visa Case information.

## Editable Fields
- Priority
- Assigned Officer
- Expected Travel Date
- Internal Notes
- Workflow Status
- Tags

## Business Rules
- Completed cases locked.
- Critical updates audited.
- Workflow rules enforced.

## Domain Events
- `VisaCaseUpdated`
- `VisaOfficerAssigned`
- `VisaPriorityChanged`

---

# Endpoint Contract: DELETE /api/v1/visa-cases/{visaCaseId}

## Business Purpose
Archives a Visa Case.

## Business Rules
- Soft Delete Only.
- Completed cases cannot be deleted.
- Audit mandatory.
- Timeline generated.

## Domain Events
- `VisaCaseArchived`

---

# Case Number Format
VIS-2027-000001
- VIS
- Year
- Incremental Number
Format configurable.

---

# Assignment Rules & Work Queue

Automatic Assignment | Manual Assignment | Branch Assignment | Workload Based Assignment | Country Specialist Assignment

## Work Queue Architecture
```
Visa Case
   │
   ▼
Assignment Engine
   │
┌──┴────────┬──────────────┐
▼           ▼              ▼
Country Team Priority Queue Workload Queue
│           │              │
└───────────┼──────────────┘
            ▼
       Visa Officer
```

---

# Enterprise Architecture & Progress

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Uploaded Documents
   ├── Verification
   ├── Embassy Submission
   ├── Appointments
   ├── Timeline
   ├── Notes
   ├── Incidents
   └── Attachments
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ⬜ Visa Types & Requirements
- ⬜ Document Management
- ⬜ Document Verification
- ⬜ Embassy Processing
- ⬜ Appointments & Biometrics
- ⬜ Visa Status & Workflow
- ⬜ Passport Tracking
- ⬜ Incident Management
- ⬜ Notes & Timeline
- ⬜ Dashboard & Analytics
- ⬜ Enterprise Search
- ⬜ Final Enterprise Architecture

Progress: ~16%

---

# Dynamic Requirements Engine Recommendation

Before designing Document Management, build a Dynamic Requirements Engine rather than hardcoding document lists.

Required documents depend on:
- Destination country
- Visa type
- Traveler nationality
- Age (adult, child, infant)
- Employment status
- Sponsor requirements
- Embassy policy changes

---

# Part 3 — Visa Types & Requirements APIs

## Overview

The Visa Requirements module manages all configurable rules that determine eligibility, required documents, fees, processing timelines, and embassy-specific policies.

Requirements are configuration-driven. No country-specific rules are hardcoded in application code.

---

# Requirements Architecture

Country ↓ Embassy ↓ Visa Type ↓ Requirement Profile ↓ Eligibility Rules ↓ Required Documents ↓ Validation Rules ↓ Visa Application

## Requirement Hierarchy

Country ↓ Embassy ↓ Visa Type ↓ Nationality ↓ Traveler Category ↓ Requirement Profile

Example:
Saudi Arabia ↓ Saudi Embassy Karachi ↓ Umrah Visa ↓ Pakistani National ↓ Adult ↓ Requirement Profile

---

# Endpoint Contract: GET /api/v1/visa-types

## Business Purpose
Returns all supported visa types.

## Query Parameters
- `page`
- `pageSize`
- `status` (active/inactive)
- `search`

## Response Includes
- Visa Type ID
- Visa Type Name
- Code
- Category
- Default Processing Days
- Default Validity
- Status

## Business Rules
- Supports pagination.
- Supports active/inactive status.
- Supports localization.

---

# Endpoint Contract: GET /api/v1/countries/{countryId}/visa-requirements

## Business Purpose
Returns requirement profiles for a country.

## Query Parameters
- `visaTypeId`
- `nationalityId`
- `travelerCategory` (Adult, Child, Infant, Senior)
- `embassyId`
- `travelPurpose`

## Response Includes
- Requirement Profile
- Eligibility Rules
- Required Documents
- Processing Time
- Validity
- Fees
- Medical Required
- Interview Required
- Biometrics Required
- Insurance Required
- Special Notes

## Business Rules
- Only active requirement profiles returned.
- Most specific profile takes precedence.
- Fallback to default profile if no exact match exists.

---

# Endpoint Contract: POST /api/v1/requirement-profiles

## Business Purpose
Creates a configurable requirement profile.

## Request Example
```json
{
  "countryId": "Saudi Arabia",
  "embassyId": "Embassy-Karachi-01",
  "visaTypeId": "Umrah",
  "nationalityId": "Pakistani",
  "travelerCategory": "Adult",
  "processingDays": 7,
  "requiresInterview": false,
  "requiresMedical": false,
  "requiresBiometrics": true,
  "requiresInsurance": true,
  "fees": {
    "embassyFee": 100,
    "serviceFee": 30,
    "currency": "USD"
  }
}
```

## Business Workflow
Validate Country ↓ Validate Embassy ↓ Validate Visa Type ↓ Validate Nationality ↓ Create Requirement Profile ↓ Generate Audit Record ↓ Publish RequirementProfileCreated ↓ Return Success

## Domain Events
- `RequirementProfileCreated`
- `RequirementProfileUpdated`

---

# Rule Engine & Requirement Resolver

```
Requirement Profile
        │
        ▼
   Rule Engine
        │
 ┌──────┼───────────────┐
 ▼      ▼               ▼
Eligibility Rules   Document Rules   Fee Rules
        │
        ▼
Requirement Resolver
        │
        ▼
Generated Requirement Checklist
```

## Why Rule Engine is Better
- Embassy requirements change frequently.
- Passport validity, travel insurance, biometric rules can be updated without backend code changes.
- Versioned profiles ensure existing applications retain historical rules while new applications receive updated requirements.

---

# Progress Update

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Dynamic Requirement Engine (Rule Engine)
   ├── Uploaded Documents
   ├── Verification
   ├── Embassy Submission
   ├── Appointments
   ├── Timeline
   ├── Notes
   ├── Incidents
   └── Attachments
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ✅ Visa Types & Requirements
- ✅ Document Management
- ⬜ Document Verification
- ⬜ Embassy Processing
- ⬜ Appointments & Biometrics
- ⬜ Visa Status & Workflow
- ⬜ Passport Tracking
- ⬜ Incident Management
- ⬜ Notes & Timeline
- ⬜ Dashboard & Analytics
- ⬜ Enterprise Search
- ⬜ Final Enterprise Architecture

Progress: ~32%

---

# Part 4 — Document Management APIs

## Overview

The Document Management module manages the complete lifecycle of traveler documents.

It is a shared Enterprise Document Service used by:
✓ Visa
✓ Booking
✓ Customer
✓ Finance
✓ HR
✓ Compliance
✓ AI

The Visa module consumes this service.

---

# Document Architecture & Lifecycle

Traveler ↓ Visa Case ↓ Document Requirement ↓ Uploaded Document ↓ Versioning (v1, v2...) ↓ OCR Processing & AI Validation ↓ Manual Verification ↓ Approval ↓ Embassy Submission ↓ Archive

Alternative Flows: Rejected | Expired | Re-upload Required | Invalid

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}/documents

## Business Purpose
Returns all required and uploaded documents for a Visa Case.

## Response Includes
- Requirement ID
- Document ID
- Document Type
- Requirement Status
- Upload Status
- Verification Status
- Approval Status
- Expiry Date
- Latest Version
- Uploaded By
- Uploaded Date
- Current Workflow Status

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/documents

## Business Purpose
Uploads a document.

## Request Example
```json
{
  "requirementId": "req_123",
  "documentType": "Passport",
  "fileReference": "https://storage.maqvera.com/docs/passport_v1.pdf",
  "expiryDate": "2032-08-18",
  "remarks": "Clean scan of main passport page"
}
```

## Business Workflow
Validate Visa Case ↓ Validate Requirement ↓ Validate Document Type ↓ Store Metadata ↓ Create Version 1 ↓ Queue OCR & AI Validation ↓ Create Timeline ↓ Audit Log ↓ Publish DocumentUploaded

---

# Endpoint Contract: GET /api/v1/documents/{documentId}

## Business Purpose
Returns document metadata and temporary signed download URL.

## Response Includes
- Document Header
- Versions
- Approval History
- Verification History
- OCR Status & Extracted Text
- AI Validation Status
- Temporary Signed Download URL
- Audit Summary

---

# Endpoint Contract: PATCH /api/v1/documents/{documentId}

## Business Purpose
Updates document metadata (expiry date, remarks, category, visibility, tags). File contents cannot be modified; metadata only.

---

# Endpoint Contract: DELETE /api/v1/documents/{documentId}

## Business Purpose
Soft deletes / archives a document (`isSoftDeleted: true`, `deletedAt`).

---

# Part 5 — Document Verification APIs

## Overview

The Document Verification module validates uploaded documents before they are accepted for embassy submission.

Verification is performed through a multi-stage pipeline combining automated checks (Virus Scan, OCR, AI Validation, Duplicate Detection, Business Rules) and manual officer review.

The system maintains independent verification artifacts per stage for complete auditability.

---

# Verification Architecture & Pipeline

Uploaded Document ↓ Virus Scan ↓ OCR Extraction ↓ AI Validation ↓ Duplicate Detection ↓ Business Rule Validation ↓ Manual Officer Review ↓ Final Verification Decision ↓ Embassy Ready

Independent Verification Artifacts:
- Virus Scan Result
- OCR Result
- AI Validation Result
- Duplicate Detection Result
- Business Rule Result
- Manual Review Result
- Final Verification Decision

---

# Endpoint Contract: POST /api/v1/documents/{documentId}/verification/start

## Business Purpose
Starts document verification pipeline.

## Business Workflow
Validate Document ↓ Queue Virus Scan ↓ Queue OCR ↓ Queue AI Validation ↓ Perform Duplicate Detection ↓ Evaluate Business Rules ↓ Calculate Risk Score ↓ Create Timeline ↓ Audit Log ↓ Publish VerificationStarted

---

# Endpoint Contract: GET /api/v1/documents/{documentId}/verification

## Business Purpose
Returns complete verification details and independent stage results.

## Response Includes
- Verification Status & Stage
- OCR Status & Extracted Fields
- AI Validation Results & Confidence Score
- Duplicate Detection Score & Fraud Analysis
- Business Rule Evaluation Results
- Risk Score & Risk Level (Low, Medium, High, Critical)
- Manual Review Decision & Officer Remarks
- Final Decision & Embassy Readiness

---

# Endpoint Contract: POST /api/v1/documents/{documentId}/verification/manual-review

## Business Purpose
Manual officer review of document verification.

## Request Example
```json
{
  "decision": "Approved",
  "remarks": "Passport clear, readable, and matches traveler details."
}
```

## Decisions
`Approved` | `Rejected` | `Needs Better Scan` | `Needs Additional Pages` | `Forgery Suspected` | `Escalate`

---

# Endpoint Contract: POST /api/v1/documents/{documentId}/verification/reverify

## Business Purpose
Restarts verification pipeline for the latest document version while preserving past verification history.

---

# Domain Events
- `VerificationStarted`
- `VirusScanCompleted`
- `OCRCompleted`
- `AIValidationCompleted`
- `BusinessValidationCompleted`
- `ManualReviewCompleted`
- `VerificationApproved`
- `VerificationRejected`
- `VerificationRestarted`

---

# Progress Update

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Dynamic Requirement Engine
   ├── Document Management
   ├── Multi-Stage Verification Pipeline (Artifact-based)
   ├── Embassy Submission
   ├── Appointments
   ├── Timeline
   ├── Notes
   ├── Incidents
   └── Attachments
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ✅ Visa Types & Requirements
- ✅ Document Management
- ✅ Document Verification
- ✅ Embassy Processing
- ⬜ Appointments & Biometrics
- ⬜ Visa Status & Workflow
- ⬜ Passport Tracking
- ⬜ Incident Management
- ⬜ Notes & Timeline
- ⬜ Dashboard & Analytics
- ⬜ Enterprise Search
- ⬜ Final Enterprise Architecture

Progress: ~48%

---

# Part 6 — Embassy Processing APIs

## Overview

The Embassy Processing module manages the complete lifecycle of visa applications after submission to an embassy or Visa Application Center (VAC).

Embassies are modeled as an External Processing Domain. Applications can be submitted individually or queued in daily Batch Submissions.

---

# Embassy Processing Architecture & Batch Queue

```
Visa Cases Ready
       │
       ▼
Submission Queue (EmbassyBatch)
       │
 ┌─────┼─────────────┐
 ▼     ▼             ▼
Saudi UAE        USA/UK/VAC
       │
       ▼
Batch Dispatch & Courier Manifest
       │
       ▼
Embassy Processing & SLA Tracking
       │
 ┌─────┼─────────────┐
 ▼     ▼             ▼
Decisions Additional  Communication
          Docs Log    History
```

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/embassy-submissions

## Business Purpose
Creates an embassy submission for a Visa Case.

## Request Example
```json
{
  "embassyId": "embassy_saudi_khi",
  "embassyName": "Saudi Embassy / VFS VAC Karachi",
  "submissionMethod": "Courier",
  "submissionDate": "2027-02-20",
  "expectedProcessingDays": 7,
  "remarks": "Standard Umrah submission batch"
}
```

---

# Endpoint Contract: GET /api/v1/embassy-submissions/{submissionId}

## Business Purpose
Returns complete embassy submission details (status, courier tracking, SLA tracking, additional doc requests, communication log, decision, timeline).

---

# Endpoint Contract: PATCH /api/v1/embassy-submissions/{submissionId}

## Business Purpose
Updates embassy processing status, expected completion date, tracking number, or remarks.

---

# Endpoint Contract: POST /api/v1/embassy-submissions/{submissionId}/additional-documents

## Business Purpose
Registers an additional document request from the embassy.

## Request Example
```json
{
  "documentType": "Updated Bank Statement",
  "dueDate": "2027-02-28",
  "remarks": "Latest 6 months bank statement required by embassy officer."
}
```

---

# Endpoint Contract: POST /api/v1/embassy-submissions/{submissionId}/decision

## Business Purpose
Registers an embassy decision (`Approved`, `Rejected`, `Returned`, `Pending`, `Administrative Processing`, `Appeal Allowed`).

## Request Example
```json
{
  "decision": "Approved",
  "visaNumber": "V-99823411",
  "validFrom": "2027-02-22",
  "validUntil": "2027-05-22",
  "remarks": "Visa approved for 90 days single entry."
}
```

---

# Endpoint Contract: POST /api/v1/embassy-submissions/batches

## Business Purpose
Creates a Submission Queue Batch for grouping multiple visa cases into a single courier manifest / embassy dispatch.

---

# Part 7 — Appointments & Biometrics APIs

## Overview

The Appointments module manages all scheduled activities required during visa processing through a centralized Enterprise Scheduling Engine.

Supported activities include embassy interviews, biometrics collection, medical examinations, document submissions, passport collections, and vaccination appointments.

---

# Appointment Architecture & Scheduling Engine

```
Visa Case
   │
   ▼
Scheduling Engine
   │
   ├── Provider Availability
   ├── Capacity Rules
   ├── Holiday Calendar
   ├── Time Slot Generator
   ├── Reminder Engine (7d, 3d, 1d, 2h)
   ├── Conflict & Double Booking Detection
   └── Rescheduling History Engine
            │
            ▼
       Appointment (APT-YYYY-XXXXXX)
```

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}/appointments

## Business Purpose
Returns all appointments for a Visa Case ordered by appointment date.

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/appointments

## Business Purpose
Schedules a new appointment with capacity validation and double-booking conflict detection.

## Request Example
```json
{
  "appointmentType": "Biometric",
  "providerId": "provider_vfs_khi",
  "providerName": "VFS Global Karachi",
  "location": "Gerry's VAC Karachi Center",
  "appointmentDate": "2027-03-02",
  "appointmentTime": "09:30",
  "durationMinutes": 30
}
```

---

# Endpoint Contract: PATCH /api/v1/appointments/{appointmentId}

## Business Purpose
Updates appointment details or reschedules date/time (preserves rescheduling history; completed appointments are locked).

---

# Endpoint Contract: POST /api/v1/appointments/{appointmentId}/attendance

## Business Purpose
Marks attendance (`Checked In`, `Present`, `Completed`, `No Show`, `Late`, `Cancelled`).

---

# Endpoint Contract: POST /api/v1/appointments/{appointmentId}/result

## Business Purpose
Records appointment outcome (`Successful`, `Failed`, `Reschedule Required`, `Medical Failed`, `Interview Failed`, `Interview Passed`, `Biometric Completed`, `Additional Documents Required`, `Pending Review`).

---

# Domain Events
- `AppointmentScheduled`
- `AppointmentConfirmed`
- `AppointmentReminderSent`
- `AppointmentRescheduled`
- `AppointmentCancelled`
- `AppointmentCheckedIn`
- `AppointmentCompleted`
- `AppointmentMissed`
- `AppointmentAttendanceRecorded`
- `AppointmentResultRecorded`

---

# Progress Update

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Dynamic Requirement Engine
   ├── Document Management
   ├── Multi-Stage Verification Pipeline
   ├── Embassy Processing & Batch Queue
   ├── Appointments & Biometrics (Central Scheduling Engine)
   ├── Visa Status & Workflow
   ├── Passport Tracking
   ├── Incident Management
   ├── Notes & Timeline
   ├── Dashboard & Analytics
   ├── Enterprise Search
   └── Final Enterprise Architecture
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ✅ Visa Types & Requirements
- ✅ Document Management
- ✅ Document Verification
- ✅ Embassy Processing
- ✅ Appointments & Biometrics
- ✅ Visa Status & Workflow
- ⬜ Passport Tracking
- ⬜ Incident Management
- ⬜ Notes & Timeline
- ⬜ Dashboard & Analytics
- ⬜ Enterprise Search
- ⬜ Final Enterprise Architecture

Progress: ~64%

---

# Part 8 — Visa Status & Workflow APIs

## Overview

The Workflow module controls the complete lifecycle of every Visa Case.

Instead of hardcoded statuses, the workflow is driven by configurable state machines.

Each transition validates permissions, business rules, SLA policies, and required actions before allowing movement to the next state.

---

# Workflow Architecture

Visa Case

↓

Workflow Definition

↓

Current State

↓

Transition Rules

↓

Business Validation

↓

Automation

↓

Timeline

↓

Audit

---

# Workflow Components

- Workflow Definition
- Workflow State
- Workflow Transition
- Guard Conditions
- Approval Rules
- Automatic Actions
- SLA Policies
- Escalation Rules
- Notifications
- Timeline
- Audit

Everything configurable.

---

# Default Workflow

Inquiry

↓

Draft

↓

Requirements Generated

↓

Documents Pending

↓

Documents Uploaded

↓

Documents Verified

↓

Ready For Submission

↓

Submitted To Embassy

↓

Embassy Processing

↓

Interview Required (Optional)

↓

Medical Required (Optional)

↓

Additional Documents (Optional)

↓

Decision Received

↓

Visa Approved

↓

Passport Returned

↓

Completed

Alternative States

↓

Rejected

Cancelled

Withdrawn

Expired

Blacklisted

Appealed

Reopened

---

# Endpoint Contract: GET /api/v1/workflows/visa

## Business Purpose

Returns active workflow definition.

## Response Includes

- Workflow Name
- Version
- States
- Transitions
- Roles
- Actions
- SLA Rules
- Automation Rules
- Status

## Business Rules

- Read Only
- Supports Versioning
- Supports Multiple Workflows

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}/workflow

## Business Purpose

Returns workflow history for a specific Visa Case.

## Response Includes

- Current State
- Previous State
- Transition History
- Performed By
- Transition Time
- Remarks
- Timeline
- Audit Summary

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/workflow/transition

## Business Purpose

Moves Visa Case to next state.

## Request Example

```json
{
  "targetState": "Documents Verified",
  "action": "verify_all_documents",
  "remarks": "All required documents verified."
}
```

## Business Workflow

Validate Permission

↓

Validate Current State

↓

Validate Transition

↓

Validate Business Rules

↓

Execute Automation

↓

Update State

↓

Generate Timeline

↓

Generate Audit

↓

Publish Domain Event

↓

Return Success

## Validation Rules

- Transition Exists
- Role Allowed
- Tenant Match
- Branch Match
- Workflow Active
- No Pending Blocking Tasks
- All Required Documents Verified
- Embassy Rules Passed

## Business Rules

- Invalid transitions rejected.
- Completed workflows locked.
- Every transition audited.
- Workflow version preserved.

---

# Transition Rules

- **Draft → Requirements Generated**: Only if traveler exists.
- **Requirements Generated → Documents Pending**: Requirements generated successfully.
- **Documents Pending → Documents Uploaded**: Minimum required documents uploaded.
- **Documents Uploaded → Documents Verified**: Verification completed successfully.
- **Documents Verified → Ready For Submission**: No validation errors.
- **Ready For Submission → Submitted To Embassy**: Passport available & submission approved.
- **Embassy Processing → Approved**: Embassy decision received.
- **Embassy Processing → Rejected**: Embassy rejection received.

---

# Guard Conditions

- Passport Valid
- Required Documents Complete
- Medical Completed
- Interview Passed
- Fees Paid
- No Open Incidents
- No Blocking Tasks
- No Pending Verification

All configurable.

---

# Automatic Actions

- Generate Timeline
- Create Audit
- Send Notifications
- Refresh Dashboard
- Update Search Index
- Schedule Appointment
- Create Tasks
- Trigger AI Analysis
- Generate Reports

All automation configurable.

---

# SLA Policies

- Document Upload SLA
- Verification SLA
- Submission SLA
- Embassy SLA
- Passport Return SLA
- Escalation SLA

Supports configurable timers.

---

# Escalation Rules

Officer Reminder

↓

Supervisor Notification

↓

Branch Manager

↓

Operations Manager

↓

Executive Dashboard

Supports configurable escalation chains.

---

# Approval Policies

- Officer Approval
- Supervisor Approval
- Dual Approval
- Country Specialist Approval
- Finance Approval
- Administrator Approval

Policy configurable.

---

# Workflow Versioning

Workflow v1

↓

Workflow v2

↓

Workflow v3

Existing cases continue using their assigned workflow version.
New cases use latest active version.

---

# AI Coding Rules

✓ State Machine
✓ Configurable Workflow
✓ Versioned Workflows
✓ Guard Conditions
✓ Automatic Actions
✓ Event Driven
✓ Timeline
✓ Audit Logging
✓ Tenant Isolation
✓ Branch Isolation

---

# Domain Events

- `WorkflowStarted`
- `WorkflowTransitionRequested`
- `WorkflowTransitionCompleted`
- `WorkflowTransitionRejected`
- `WorkflowCompleted`
- `WorkflowReopened`
- `WorkflowEscalated`
- `WorkflowCancelled`
- `SLABreached`
- `ApprovalCompleted`

---

# Enterprise Architecture

```
                   Visa Case
                       │
                       ▼
               Workflow Engine
                       │
      ┌────────────────┼────────────────┐
      ▼                ▼                ▼
 Current State   Transition Rules   Guard Conditions
      │                │                │
      └────────────────┼────────────────┘
                       ▼
               Automation Engine
                       │
      ┌────────────────┼─────────────────┐
      ▼                ▼                 ▼
 Timeline         Notifications      Domain Events
                       │
                       ▼
                  Audit Log
```

---

# Senior Enterprise Improvement

Instead of implementing workflows directly inside your API services, introduce a dedicated Workflow Engine.

```
Visa Case
     │
     ▼
Workflow Engine
     │
     ├── State Machine
     ├── Rule Engine
     ├── SLA Engine
     ├── Approval Engine
     ├── Automation Engine
     ├── Escalation Engine
     └── Event Publisher
            │
            ▼
      Domain Events
```

### Why this is better

Without a Workflow Engine:
- Business rules become scattered across controllers and services.
- Adding a new status requires code changes.
- Embassy-specific processes are difficult to support.
- Testing workflow logic becomes harder.

With a Workflow Engine:
- Workflows become configuration-driven.
- Different countries or embassies can use different workflow definitions.
- New transitions can be added without redesigning the application.
- AI agents receive a clear state model to reason about.
- The same engine can later power Booking, CRM, Finance, HR, and Approval workflows across the ERP.

---

# Progress Update

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Dynamic Requirement Engine
   ├── Document Management
   ├── Multi-Stage Verification Pipeline
   ├── Embassy Processing & Batch Queue
   ├── Appointments & Biometrics
   ├── Visa Status & Workflow (Configurable Workflow Engine)
   ├── Passport Tracking
   ├── Incident Management
   ├── Notes & Timeline
   ├── Dashboard & Analytics
   ├── Enterprise Search
   └── Final Enterprise Architecture
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ✅ Visa Types & Requirements
- ✅ Document Management
- ✅ Document Verification
- ✅ Embassy Processing
- ✅ Appointments & Biometrics
- ✅ Visa Status & Workflow
- ✅ Passport Tracking

⬜ Incident Management
⬜ Notes & Timeline
⬜ Dashboard & Analytics
⬜ Enterprise Search
⬜ Final Enterprise Architecture

Progress: ~72%

---

# Part 9 — Passport Tracking APIs

## Overview

The Passport Tracking module manages the complete lifecycle and chain of custody for physical passports.

Every passport movement is recorded as an immutable tracking event.

The system provides full traceability from traveler submission until passport return.

---

# Business Purpose

Track:
- Passport Receipt
- Internal Transfers
- Courier Dispatch
- Embassy Delivery
- Embassy Return
- Branch Delivery
- Traveler Collection
- Lost Passport Investigation
- Chain of Custody

Passport movement is event-driven. Never overwrite history.

---

# Passport Lifecycle

Traveler Submitted
↓
Branch Received
↓
Verification
↓
Ready For Dispatch
↓
Courier Picked Up
↓
Embassy Received
↓
Embassy Processing
↓
Ready For Return
↓
Courier Returned
↓
Branch Received
↓
Traveler Collected

Alternative Flow:
Lost | Damaged | Returned | Cancelled

Workflow configurable.

---

# Passport Architecture

Traveler
↓
Visa Case
↓
Passport Record
↓
Tracking Events
↓
Current Location
↓
Custody History
↓
Final Collection

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}/passport

## Business Purpose

Returns passport information and complete custody history.

## Response Includes

- Passport Number
- Nationality
- Issue Date
- Expiry Date
- Current Status
- Current Holder
- Current Location
- Tracking Number
- Courier
- Embassy
- Timeline
- Latest Event

## Business Rules

- Read Only
- Latest Location Always Returned
- Complete History Available

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/passport/receive

## Business Purpose

Registers passport received from traveler.

## Request Example

```json
{
  "receivedBy": "UUID",
  "receivedDate": "2027-03-01",
  "remarks": "Original passport received."
}
```

## Business Workflow

Validate Visa Case → Validate Passport → Receive Passport → Generate Tracking Event → Update Current Holder → Create Timeline → Audit → Publish PassportReceived → Return Success

## Validation Rules

- Visa Case Exists
- Passport Exists
- Passport Not Already Received
- Tenant Match
- Branch Match

---

# Endpoint Contract: POST /api/v1/passports/{passportId}/transfer

## Business Purpose

Transfers passport custody between internal staff, teams, couriers, or branches.

## Supported Transfers

Officer → Supervisor → Courier → Embassy → Branch → Traveler

## Request Example

```json
{
  "from": "Operations",
  "to": "Courier",
  "handoverTime": "2027-03-02T09:30",
  "remarks": "Daily embassy dispatch"
}
```

## Business Workflow

Validate Custody → Validate Receiver → Generate Tracking Event → Update Holder → Update Location → Timeline → Audit → Publish PassportTransferred

---

# Endpoint Contract: POST /api/v1/passports/{passportId}/dispatch

## Business Purpose

Dispatches passport to embassy/VAC.

## Response Includes

- Dispatch Number
- Courier
- Tracking Number
- Dispatch Time
- Expected Delivery
- Current Status

---

# Endpoint Contract: POST /api/v1/passports/{passportId}/receive-from-embassy

## Business Purpose

Registers passport returned by embassy.

## Business Workflow

Validate Dispatch → Receive Passport → Update Tracking → Update Visa Case → Generate Timeline → Audit → Publish PassportReturned

---

# Endpoint Contract: POST /api/v1/passports/{passportId}/collect

## Business Purpose

Traveler collects passport from branch.

## Request Example

```json
{
  "collectedBy": "Traveler",
  "identityVerified": true,
  "remarks": "Passport handed over to traveler after verification."
}
```

## Business Rules

- Identity verification mandatory.
- Receipt generated.
- Collection irreversible.
- Timeline created.

---

# Current Passport Statuses

`Received` | `Under Verification` | `Ready For Dispatch` | `Dispatched` | `With Courier` | `At Embassy` | `Embassy Processing` | `Returned` | `Ready For Collection` | `Collected` | `Lost` | `Damaged` | `Cancelled`

Configurable.

---

# Tracking Event Schema

Every movement records:
- Event ID
- Timestamp
- Previous Holder
- New Holder
- Previous Location
- New Location
- Performed By
- Reason
- Remarks
- Digital Signature (Future)
- GPS (Future)

---

# Chain Of Custody

Traveler → Front Desk → Visa Officer → Supervisor → Courier → Embassy → Courier → Branch → Traveler

History cannot be modified.

---

# Courier Integration

- Courier Company
- Tracking Number
- Shipment Status
- Delivery Date
- Pickup Date
- Expected Return

Future courier API integration supported.

---

# Lost Passport Procedure

Create Incident → Lock Visa Case → Notify Management → Generate Timeline → Investigation → Resolution

Workflow configurable.

---

# AI Coding Rules

✓ Event Sourcing Style Tracking
✓ Immutable History
✓ Chain Of Custody
✓ Timeline
✓ Audit Logging
✓ Tenant Isolation
✓ Branch Isolation
✓ Digital Signature Ready
✓ Courier Integration Ready

---

# Domain Events

- `PassportReceived`
- `PassportTransferred`
- `PassportDispatched`
- `PassportDelivered`
- `PassportReturned`
- `PassportCollected`
- `PassportLost`
- `PassportDamaged`
- `PassportCustodyChanged`
- `PassportTrackingUpdated`

---

# Enterprise Architecture

```
Traveler
      │
      ▼
Passport Record
      │
      ▼
Tracking Engine
      │
      ├── Custody Events
      ├── Current Holder
      ├── Current Location
      ├── Courier Tracking
      ├── Embassy Tracking
      ├── Timeline
      └── Audit
               │
               ▼
        Chain of Custody
```

---

# Senior Enterprise Improvement

Instead of updating the passport record directly, introduce a dedicated Passport Tracking Engine.

```
Passport
     │
     ▼
Passport Tracking Engine
     │
     ├── Custody Manager
     ├── Location Manager
     ├── Transfer Validator
     ├── Courier Integration
     ├── Timeline Generator
     ├── Audit Generator
     ├── SLA Tracker
     └── Event Publisher
            │
            ▼
      Tracking History
```

### Why this is better

Treating passports as tracked assets provides:
- A complete, immutable chain of custody.
- Easier investigation if a passport is lost or delayed.
- Clear accountability for every handoff.
- Seamless integration with courier APIs and barcode/QR scanning.
- Better support for high-volume agencies handling thousands of passports.
- A reusable tracking engine that can later be used for other physical assets (original certificates, contracts, ID cards, etc.).

---

# Progress Update

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Dynamic Requirement Engine
   ├── Document Management
   ├── Multi-Stage Verification Pipeline
   ├── Embassy Processing & Batch Queue
   ├── Appointments & Biometrics
   ├── Visa Status & Workflow (Configurable Workflow Engine)
   ├── Passport Tracking (Passport Chain of Custody System)
   ├── Incident Management (Centralized Case Incident Engine)
   ├── Notes & Timeline
   ├── Dashboard & Analytics
   ├── Enterprise Search
   └── Final Enterprise Architecture
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ✅ Visa Types & Requirements
- ✅ Document Management
- ✅ Document Verification
- ✅ Embassy Processing
- ✅ Appointments & Biometrics
- ✅ Visa Status & Workflow
- ✅ Passport Tracking
- ✅ Incident Management

⬜ Notes & Timeline
⬜ Dashboard & Analytics
⬜ Enterprise Search
⬜ Final Enterprise Architecture

Progress: ~80%

---

# Part 10 — Incident Management APIs

## Overview

The Incident Management module provides a centralized Case Incident Engine for handling all operational exceptions, delays, and critical disruptions during visa processing.

Incidents are modeled as structured entities with severity levels, ownership assignment, strict SLA targets, evidence collection, investigation logs, and resolution workflows.

---

# Business Purpose

Manage and track:
- Lost Passport Investigations
- Embassy Rejections & Refusals
- Missing Required Documents
- Medical Examination Failures
- Biometric Collection Failures
- Missed Appointments & Interviews
- Courier & Transit Delays
- Fraud & Forged Document Alerts
- Overstay & Visa Violation Alerts
- Blacklist Checks
- Emergency Escalations

Incidents enforce full operational accountability and event-driven resolution.

---

# Incident Lifecycle

Reported
↓
Validated
↓
Assigned
↓
In Investigation
↓
Action Taken
↓
Resolved
↓
Closed

Alternative Flow:
Rejected | Duplicate | Escalated | Reopened

Workflow configurable.

---

# Incident Architecture

Visa Case
↓
Case Incident Engine
↓
Incident Record (INC-YYYY-XXXXXX)
↓
SLA Tracker (First Response / Resolution SLA)
↓
Investigation & Evidence Collector
↓
Resolution Engine
↓
Timeline & Audit Log
↓
Domain Event Publisher

---

# Endpoint Contract: GET /api/v1/incidents

## Business Purpose

Returns a paginated list of operational incidents across visa cases.

## Query Parameters

- `page`
- `pageSize`
- `visaCaseId`
- `category`
- `severity` (Low, Medium, High, Critical, Emergency)
- `status` (reported, assigned, in_investigation, resolved, closed, escalated)
- `assignedTo`
- `dateFrom`
- `dateTo`

## Response Includes

- Incident ID
- Incident Number
- Visa Case ID
- Category
- Severity
- Status
- Title
- Description
- Assigned To
- Reported By
- SLA Status & Breach Flag
- Created Date

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/incidents

## Business Purpose

Reports a new operational incident for a Visa Case.

## Request Example

```json
{
  "category": "Lost Passport",
  "severity": "Emergency",
  "title": "Original passport misplaced during courier transit",
  "description": "Passport was picked up by courier but not received at VFS Karachi.",
  "assignedTeam": "Operations",
  "affectedTravelerIds": ["60d5ecb8b5c9c2234c8e4321"]
}
```

## Business Workflow

Validate Visa Case → Check Active Incidents → Create Incident (INC-YYYY-XXXXXX) → Auto-Lock Visa Case (if Critical/Emergency or Lost Passport) → Start SLA Timers → Generate Timeline → Audit Log → Publish IncidentReported → Return Success

---

# Endpoint Contract: GET /api/v1/incidents/{incidentId}

## Business Purpose

Returns complete incident details, investigation evidence, interviews, AI pattern analysis, SLA status, and resolution history.

---

# Endpoint Contract: PATCH /api/v1/incidents/{incidentId}

## Business Purpose

Updates incident severity, assigned officer, status, or operational notes.

---

# Endpoint Contract: POST /api/v1/incidents/{incidentId}/investigation/evidence

## Business Purpose

Attaches investigation evidence (documents, photos, courier receipts, system logs) to an open incident.

---

# Endpoint Contract: POST /api/v1/incidents/{incidentId}/resolve

## Business Purpose

Marks an operational incident as resolved.

## Request Example

```json
{
  "resolutionSummary": "Passport located at courier warehouse and delivered to embassy.",
  "rootCause": "Misplaced barcode tag at sorting facility.",
  "correctiveAction": "Courier completed priority handoff to embassy officer.",
  "preventiveAction": "Enforced QR code scan acknowledgement at all handoffs."
}
```

## Business Workflow

Validate Resolution → Update Status (`resolved`) → Unlock Visa Case (if locked) → Calculate Final SLA Compliance → Generate Timeline → Generate Audit → Publish IncidentResolved → Return Success

---

# SLA Management

- **First Response Time**
- **Investigation Time**
- **Resolution Time**
- **Closure Time**
- **Escalation Time**

Supports configurable SLA rules.

---

# Escalation Chain

Officer
↓
Supervisor
↓
Branch Manager
↓
Operations Manager
↓
Executive Dashboard

Escalation configurable.

---

# Related Records

- Visa Case
- Traveler
- Passport
- Embassy Submission
- Appointment
- Documents
- Payments
- Timeline
- Tasks

Incidents can reference multiple business entities.

---

# Corrective Actions

- Upload Missing Documents
- Reissue Passport
- Resubmit Application
- Schedule Medical
- Request Embassy Clarification
- Contact Courier
- Refund Customer
- Escalate Management
- Custom Actions

---

# AI Analysis & Risk Score Engine

- Pattern Detection across recurring failure modes.
- Fraud & Forgery Probability Score (0-100).
- Recommended Preventive Actions automatically suggested to officers.

---

# AI Coding Rules

✓ Independent Incident Aggregate
✓ Timeline Generation
✓ SLA Tracking
✓ Audit Logging
✓ Event Driven
✓ Configurable Categories
✓ Configurable Severity
✓ Tenant Isolation
✓ Branch Isolation

---

# Domain Events

- `IncidentCreated`
- `IncidentAssigned`
- `IncidentEscalated`
- `IncidentUpdated`
- `InvestigationStarted`
- `CorrectiveActionCreated`
- `IncidentResolved`
- `IncidentVerified`
- `IncidentClosed`
- `IncidentReopened`

---

# Enterprise Architecture

```
Visa Case
│
▼
Incident
│
├── Investigation
├── Evidence
├── Attachments
├── Corrective Actions
├── Preventive Actions
├── Timeline
├── SLA
├── Audit
└── Resolution
```

---

# Senior Enterprise Improvement (Highly Recommended)

Instead of keeping incidents isolated inside the Visa module, build a centralized Enterprise Incident Engine.

```
CRM
│
Booking
│
Travel
│
Visa
│
Finance
│
HR
│
Compliance
│
▼
Enterprise Incident Engine
│
├── Incident Registry
├── SLA Engine
├── Assignment Engine
├── Escalation Engine
├── Investigation Engine
├── Root Cause Analysis
├── Preventive Action Engine
├── Analytics
└── Event Publisher
```

### Why this is better

Without a shared Incident Engine:
- Every module implements different incident logic.
- SLA calculations become inconsistent.
- Reporting across departments is difficult.
- AI cannot analyze organization-wide operational problems.

With a shared Incident Engine:
- One consistent incident lifecycle across the ERP.
- Unified SLA and escalation policies.
- Cross-module reporting (Visa, Travel, CRM, Finance, etc.).
- AI can identify recurring operational issues, recommend preventive actions, and highlight systemic risks.

---

# Progress Update

```
Traveler
   │
   ▼
Visa Case
   │
   ├── Visa Application
   ├── Required Documents
   ├── Dynamic Requirement Engine
   ├── Document Management
   ├── Multi-Stage Verification Pipeline
   ├── Embassy Processing & Batch Queue
   ├── Appointments & Biometrics
   ├── Visa Status & Workflow (Configurable Workflow Engine)
   ├── Passport Tracking (Passport Chain of Custody System)
   ├── Incident Management (Centralized Case Incident Engine)
   ├── Notes & Timeline
   ├── Dashboard & Analytics
   ├── Enterprise Search
   └── Final Enterprise Architecture
```

## Progress
- ✅ Module Foundation
- ✅ Visa Application CRUD
- ✅ Visa Types & Requirements
- ✅ Document Management
- ✅ Document Verification
- ✅ Embassy Processing
- ✅ Appointments & Biometrics
- ✅ Visa Status & Workflow
- ✅ Passport Tracking
- ✅ Incident Management

⬜ Notes & Timeline
⬜ Dashboard & Analytics
⬜ Enterprise Search
⬜ Final Enterprise Architecture

Progress: ~80%

---

# 🚀 Next Module

The next section will be **Part 11 — Notes & Timeline APIs**.

Rather than storing plain notes, we'll design a complete Activity Timeline Engine that automatically records every important event in a Visa Case, including:
- Status transitions
- Document uploads
- Verification results
- Embassy submissions
- Passport movements
- Appointment events
- Incident activities
- Officer comments
- Audit entries

This will create a single chronological history of the Visa Case, making debugging, auditing, customer support, and AI-assisted reasoning significantly easier.

---

# Part 11 — Notes & Timeline APIs

## Overview

The Notes & Timeline module is a centralized **Enterprise Timeline Engine** (`EnterpriseTimelineEngineService`) shared between the Visa and Travel domains, not a Visa-only feature. Every business action across the module publishes a domain event; `VisaTimelineEventBus` normalizes 18 of those events (case, workflow, documents, verification, embassy, appointments, passport, incidents) into a canonical, immutable `TravelTimelineModel` entry. Manual notes go through the same engine, so system-generated and human-authored history live in one append-only collection.

Timeline records are never edited or deleted — `archiveEvent` only changes discoverability, the underlying document is untouched.

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}/timeline

## Business Purpose

Returns the newest-first, paginated activity history of a Visa Case.

## Query Parameters

- `page`, `pageSize`
- `eventType`, `module` (source module, e.g. `Documents`, `Embassy`, `Incidents`)
- `performedBy`
- `dateFrom`, `dateTo`
- `visibility`, `search`

## Response Includes

- Event ID, Timestamp (`createdAt`), Event Type, Module (`sourceModule`)
- Description, Actor (`userId`/`name`/`role`)
- Visibility, Attachments, Comments, Correlation ID, Metadata

## Business Rules

- Requires `visa.timeline.read` (or `visa.read`/`admin`).
- `Private`-visibility entries are hidden from every requester except the original author or an admin.
- Missing `branchId` defaults to `"main"` (not an unscoped cross-branch read).

---

# Endpoint Contract: POST /api/v1/visa-cases/{visaCaseId}/notes

## Business Purpose

Creates a manual operational note and its corresponding immutable timeline event in one transaction.

## Request Example

```json
{
  "noteType": "Internal",
  "text": "Embassy requested updated employment letter.",
  "visibility": "Internal"
}
```

## Business Workflow

Validate Permission (`visa.notes.write`) → Validate Visa Case Exists/Branch Match → Validate Note Type & Visibility against the tenant's active `TimelinePolicyModel` → Create Note → Create Timeline Event → Audit → Publish `ManualNoteCreated` → Return Success

## Note Types (tenant-configurable via `TimelinePolicyModel`, seeded by `scripts/seedTimelinePolicy.js`)

Internal, Customer, Embassy, Compliance, Finance, Management, AI, Private, Shared

## Visibility Levels

Public, Internal, Operations, Management, Customer Visible, Private, System

---

# Endpoint Contract: GET /api/v1/timeline/{eventId}

## Business Purpose

Returns a single immutable timeline event with its full context.

## Response Includes

- Event Header, Description, Attachments, Comments, Metadata
- `relatedRecords` (Visa Case ID, Travel Plan ID, aggregate type/ID)
- `auditSummary` — matching `AuditLogModel` entries for this event

---

# Endpoint Contract: GET /api/v1/visa-cases/{visaCaseId}/ai-context

## Business Purpose

Builds a read-only AI prompt context (case summary, chronological history, pending actions) from real timeline and Visa Case data. AI reads this context; it never writes back to the timeline.

---

# AI Coding Rules

✓ Immutable Timeline
✓ Event Driven
✓ Full Text Search (indexed into the Enterprise Search Platform)
✓ Audit Logging
✓ Tenant Isolation
✓ Branch Isolation
✓ Correlation IDs
✓ Timeline Generated Automatically

---

# Domain Events

- `TimelineEventCreated`
- `ManualNoteCreated`
- `TimelineIndexed`
- `TimelineArchived`
- `TimelineCommentAdded`
- `TimelineAttachmentAdded`

---

# Enterprise Architecture

```
Visa Case
     │
     ▼
Timeline Engine (shared with Travel)
     │
 ├── Automatic Events (VisaTimelineEventBus)
 ├── Manual Notes (TimelinePolicyModel-governed)
 ├── AI Context Provider
 ├── Search Index (SearchEngineService)
 └── Unified Activity Stream
```

Already implemented as the centralized engine the doc's own "Senior Enterprise Improvement" section recommends — Travel Plans use the same `EnterpriseTimelineEngineService`, not a parallel implementation.

---

# Part 12 — Dashboard & Analytics APIs

## Overview

Dashboards never query transactional Visa collections directly. `KPIEngine.computeVisaMetrics` aggregates real data into a materialized `VisaAnalyticsSummaryModel` (and a per-customer `VisaCustomerAnalyticsSummaryModel`), refreshed two ways: event-driven (16 domain events trigger an async `refreshVisaSummary`) and by `analyticsScheduler.js` (incremental cron every few minutes, full nightly rebuild). `VisaAnalyticsEngine` serves dashboards from that summary table through `CacheManager` (Redis if configured, in-memory fallback otherwise).

## Endpoint Contract: GET /api/v1/dashboard/{executive|operations|officer|embassy|branch|finance|customer|compliance|ai-insights}

## Business Purpose

Returns one of 9 role-scoped dashboards, each reading only from the cached summary table.

## Business Rules

- `executive`, `finance`, `compliance`, and `ai-insights` require a management role (`administrator`, `manager`, `director`, `executive`, `finance`, `compliance`).
- `branchId=all` (branch-wide visibility) also requires a management role.
- **Sensitive KPI masking**: `branch` dashboard (available to non-management branch staff) strips `revenue`/`refundRatio` unless the requester holds a management role.
- Every dashboard view is written to `AuditLogModel` (`VIEW_DASHBOARD`) — Search/Dashboard Audit Access.

## Endpoint Contract: GET /api/v1/dashboard/kpis

Returns the tenant/branch KPI set: approval rate, rejection rate, average processing time, embassy SLA compliance, revenue, refund ratio, officer productivity.

## Endpoint Contract: GET /api/v1/dashboard/trends

## Query Parameters

- `period` — `Today`, `Yesterday`, `Daily`, `Weekly`, `7 Days`, `Monthly`, `30 Days`, `Quarterly`, `90 Days`, `Yearly`, `1 Year`
- `dateFrom`, `dateTo` — **Custom Date Range**, validated against `DASHBOARD_TREND_MAX_RANGE_DAYS`

---

# AI Insights

Deterministic, threshold-based day-over-day comparisons against yesterday's persisted summary (overloaded officers, common rejection reasons, delayed embassies, revenue forecast) — not a black-box model. AI reads analytics; it never writes KPIs.

---

# AI Coding Rules

✓ Read Optimized ✓ Summary Tables ✓ Materialized Views ✓ Redis Cache
✓ Event Driven ✓ Background Workers ✓ Tenant Isolation ✓ Branch Isolation
✓ No Direct Aggregation (dashboards read `VisaAnalyticsSummaryModel` only)

---

# Domain Events

- `DashboardRefreshed`
- `KPICalculated`
- `AnalyticsUpdated`
- `SLAExceeded`
- `PerformanceSnapshotCreated`
- `RevenueSummaryUpdated`
- `OfficerMetricsUpdated`
- `EmbassyMetricsUpdated`

---

# Part 13 — Enterprise Search APIs

## Overview

`SearchEngineService` is a centralized Enterprise Search Platform (`SearchIndexModel`), already shared across Visa and Travel Operations — not a Visa-only search. Over 40 domain events keep the index asynchronously synchronized; search requests never touch operational Visa/Travel/Document/Incident collections.

## Endpoint Contract: GET /api/v1/search

## Query Parameters

`q`, `entityType`, `country`, `embassy`, `visaType`, `status`, `officer`, `nationality`, `priority`, `severity`, `branchId`, `dateFrom`, `dateTo`, `page`, `pageSize`, `sort`, `order`

## Response Includes

Entity Type, Entity ID, Title, Description, Matched Field, **Matched Text / Highlighted Match** (`<mark>`-wrapped snippet), Score / Confidence Score, `isFuzzyMatch`, Created Date, Status, Navigation URL, Facets

## Business Rules

- Role-based visibility via `permissionsRequired` on each indexed document; tenant and branch isolation on every query.
- Redis-cached (`SEARCH_CACHE_TTL_SECONDS`) — cache key includes the requester's permission set so results never leak across differently-permissioned users; invalidated on every index write.
- **Advanced Search**: default AND across space-separated terms, explicit `OR` groups, `NOT`/`-term` exclusion, a fully-quoted query as an exact phrase.
- **Fuzzy Search**: bounded Levenshtein-distance fallback (`SEARCH_FUZZY_MAX_DISTANCE`, `SEARCH_FUZZY_CANDIDATE_LIMIT`), only triggered when the exact/boolean pass returns zero hits — honestly labeled `isFuzzyMatch`, not a real phonetic/typo-tolerant search index.
- **Field-level security**: passport numbers are masked to their last 4 digits at index time.
- Every query is written to `AuditLogModel` (`SEARCH_QUERY`) — Search Audit Logging.

## Entity Specific Search

`GET /api/v1/search/{visa-cases|travelers|passports|documents|incidents|appointments|embassies}`

## Saved Searches / Recent Searches

`POST|GET /api/v1/search/saved`, `DELETE /api/v1/search/saved/{savedSearchId}`, `GET /api/v1/search/suggestions`. `visibility: "department"` saved searches are resolved through `EmployeeProfileModel`'s real `departmentId` link and surfaced to teammates in the same department, not just the author.

## Endpoint Contract: POST /api/v1/search/rebuild

Admin-only (`search.rebuild` or `admin`). Full, batched reindex of Visa Cases, Travelers, Documents, Embassy Submissions, Appointments, Passports, and Incidents for a tenant.

---

# AI Coding Rules

✓ Dedicated Search Engine ✓ Asynchronous Indexing ✓ Event Driven ✓ Full Text Search
✓ Faceted Search ✓ Fuzzy Matching ✓ Role Based Access ✓ Tenant Isolation
✓ Branch Isolation ✓ No Direct Database Search

---

# Domain Events

- `SearchIndexCreated`
- `SearchIndexUpdated`
- `SearchIndexDeleted`
- `SearchRebuilt`
- `SearchRequested`
- `SavedSearchCreated`
- `SearchSuggestionGenerated`
- `SearchCacheRefreshed`

## Honest Limitation

Wildcards, nested boolean grouping, true phonetic matching, and semantic/natural-language search need a real search engine (OpenSearch/Elasticsearch). The current MongoDB-regex + Levenshtein-fallback backend is a genuine, DB-backed implementation of everything above it, not a placeholder — but it is not a substitute for those specific capabilities, and this document says so rather than claiming them.

---

# Part 14 — Final Enterprise Architecture

## Overview

The Visa module is organized as Domain-Driven Design bounded contexts communicating through REST (synchronous, user-facing) and domain events (asynchronous, cross-context). That structural claim is true of the actual codebase. The remainder of this section describes the **real, as-built infrastructure** — not a generic technology template — because a blueprint that names infrastructure the codebase doesn't run would mislead the next developer or coding agent more than it would help.

## Actual Runtime Stack

| Layer | This codebase | Note |
| --- | --- | --- |
| Application | Node.js / Express 5, ESM | Modular monolith, not microservices |
| Primary database | **MongoDB via Mongoose** | Not PostgreSQL — every model in `models/*.js` is a Mongoose schema |
| Multi-tenancy | `tenantId`/`branchId` on every document, enforced at the query boundary | No separate database per tenant |
| Cache | `CacheManager` — Redis when `REDIS_URL` is set and reachable, in-memory `Map` fallback otherwise | One API either way; services never call Redis directly |
| Search | `SearchIndexModel` (MongoDB) + `SearchEngineService` | Not OpenSearch/Elasticsearch yet — see Part 13's Honest Limitation |
| Background jobs | `node-cron` (`analyticsScheduler.js`, `incidentSlaScheduler.js`, `appointmentReminderScheduler.js`, `documentExpiryScheduler.js`) | Not Hangfire/Quartz/Celery — those are .NET/Java/Python schedulers, not applicable to this Node stack |
| Event bus | `utils/eventBus.js` — in-process `EventEmitter`, durable outbox to `DomainEventModel` when `EVENT_OUTBOX_ENABLED=true` | Not Kafka/RabbitMQ/Azure Service Bus by default; horizontal scaling needs a real broker adapter, not yet implemented |
| File storage | `utils/fileStorage.js` — local disk, Cloudinary, or S3-compatible, selected by `FILE_STORAGE_BACKEND` | Matches the doc's "Cloud Storage" line |
| IDs | MongoDB `ObjectId` | Not UUID primary keys |
| Architecture pattern | Services call Mongoose models directly (`services/*.js`) | No Repository/Unit-of-Work/DI-container abstraction exists in this codebase |

## Bounded Contexts (as actually built)

Identity (existing auth system: JWT, RBAC, MFA) · Traveler (`CustomerModel`) · Visa Case (`VisaService`, `VisaCaseModel`) · Requirement (`VisaRequirementService`) · Document (`EnterpriseDocumentService`, `DocumentVerificationService`) · Workflow (`WorkflowEngine`, `VisaWorkflowService`) · Embassy (`EmbassyProcessingService`) · Appointment (`SchedulingEngineService`) · Passport (`PassportTrackingEngineService`) · Incident (`EnterpriseIncidentEngineService`, shared with Travel) · Timeline (`EnterpriseTimelineEngineService`, shared with Travel) · Analytics (`KPIEngine`, `VisaAnalyticsEngine`) · Search (`SearchEngineService`, shared with Travel)

Three of these (Incident, Timeline, Search) are already the centralized, cross-module engines the doc's own "Senior/Principal Architect Improvement" sections recommend — not Visa-only implementations, confirmed by direct code audit across Parts 10, 11, and 13.

## Data Ownership

Each service file is the only writer of its own Mongoose collections (verified across all 14 parts — no cross-context direct collection writes were found; every cross-context read goes through a summary/index/timeline collection, and every cross-context action goes through `publishEvent`/`subscribeEvent`).

## CQRS Read Model

Real, not aspirational: `VisaAnalyticsSummaryModel`/`VisaCustomerAnalyticsSummaryModel` (dashboard read side) and `SearchIndexModel` (search read side) are both genuinely separate collections, populated asynchronously from domain events and never read together with the write-side Visa Case collection in the same request.

## AI Integration Points (real vs. deferred)

Implemented: document verification confidence/risk scoring (Part 5), incident pattern flags, dashboard AI insights via deterministic threshold comparison (Part 12), Visa Case AI context provider for LLM prompting (Part 11). AI is advisory everywhere it appears; every state transition remains a human/workflow-engine decision. **Deferred**: semantic/natural-language search, fraud-model scoring beyond rule-based checks, embassy delay prediction models, SLA prediction models, and a customer chat assistant — none of these exist in the codebase yet.

## External Integrations — Honest Status

**Implemented**: file storage providers (Cloudinary/S3/local). **Not implemented anywhere in this codebase**: real Embassy APIs, Courier APIs, Payment Gateway, Email, SMS, WhatsApp, Google Calendar, Microsoft Outlook, or third-party OCR/Identity-Verification providers. Every "notify", "send", or "escalate" business action across Parts 1–13 was implemented as a real, honest `NotificationRequested` domain event — a genuine hook a real provider adapter can subscribe to — rather than a fake pass-through pretending an SMS or email was sent. Wiring one of these providers means adding an adapter under a namespaced config module (matching `utils/gdsConfig.js`'s existing pattern) and subscribing it to the relevant domain events; none of that groundwork requires changing this document's bounded contexts.

## Security (real)

JWT access/refresh tokens, bcrypt password hashing, TOTP/email/SMS MFA scaffolding, RBAC via permission-string checks (`permissions.includes(...)`) on every mutating endpoint audited this session, tenant/branch isolation at the query boundary, `AuditLogModel` entries for dashboard views, search queries, and every incident/investigation/note mutation, and per-route `express-rate-limit`. Encryption at rest/in transit and a secrets manager are infrastructure/deployment concerns (TLS termination, disk encryption, a vault) outside this application's code, same as the "Provider configurable" framing in the Database Strategy section above.

## Scalability Strategy (real vs. deferred)

Real today: stateless Express processes, `CacheManager` (Redis-capable), background cron workers, object storage offloaded from the app server. **Deferred**: a message-broker-backed event bus for multi-instance deployments (documented as a known gap in `utils/eventBus.js` since this codebase's first session), MongoDB read replicas/sharding, and a CDN — all standard MongoDB Atlas / infrastructure-layer configuration, not application code changes.

## Coding Agent Guidelines (reconciled to this codebase's real conventions)

- Layering: `routes → controllers → services → models`. Controllers stay thin (pull tenant/branch/user context, call one service method, map errors to status codes). Services own all business logic and are the only layer that touches Mongoose models.
- No hardcoded enums: status lists, workflow transitions, visibility levels, note types, and thresholds come from `utils/*Config.js` functions with env-var JSON overrides, or from tenant-scoped policy collections (`TimelinePolicyModel`, `IncidentPolicyModel`) — never a literal array in a controller.
- Every mutating endpoint checks `req.auth.permissions` against a specific + domain-wide + `admin` fallback chain.
- Every entity with a documented Domain Event list actually publishes every event on that list under its literal doc name — verified and fixed as a recurring bug class in Parts 9–13.
- Soft deletes (`isSoftDeleted`) and tenant/branch fields are present on every domain collection; there are no hard deletes of business records.
- `ObjectId`s are this codebase's primary keys — do not introduce UUID PKs inconsistently with the rest of the schema.
- AI assists (verification scoring, dashboard insights, AI context) but never finalizes a business decision — every AI signal feeds a human/workflow-engine approval step.

## Final Vision

The Visa module, as actually implemented and audited across Parts 1–13 of this document, is not a CRUD scaffold: it has real event-driven cross-module engines for Timeline, Incidents, Analytics, and Search shared with the Travel domain, real materialized read models, real background workers, and real (not fabricated) hooks for every external integration that hasn't been wired yet. This section intentionally corrects the generic PostgreSQL/OpenSearch/Kafka/Hangfire template pasted into this conversation against what actually runs, so this document remains trustworthy as the implementation contract it claims to be.

---

# 🎉 Visa API Module Status

- ✅ Part 1 — Module Foundation
- ✅ Part 2 — Visa Application CRUD
- ✅ Part 3 — Visa Types & Requirements
- ✅ Part 4 — Document Management
- ✅ Part 5 — Document Verification
- ✅ Part 6 — Embassy Processing
- ✅ Part 7 — Appointments & Biometrics
- ✅ Part 8 — Visa Status & Workflow
- ✅ Part 9 — Passport Tracking
- ✅ Part 10 — Incident Management
- ✅ Part 11 — Notes & Timeline
- ✅ Part 12 — Dashboard & Analytics
- ✅ Part 13 — Enterprise Search
- ✅ Part 14 — Final Enterprise Architecture

Status: ✅ COMPLETE (100%) — audited against the real codebase, not assumed from file/function names.









