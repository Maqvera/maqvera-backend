---
title: Travel Operations API - Final Enterprise Architecture
document_id: API-007
version: 1.0.0
status: Production Ready
module: Travel Operations
---

# Travel Operations API

---

# 1. Overview

The Travel Operations module manages the execution of travel services after a booking has been confirmed.

Unlike the Booking module, which manages reservations and planning, this module manages real operational activities before, during, and after travel.

Examples
• Flight Coordination
• Hotel Allocation
• Room Assignment
• Transport Scheduling
• Departure Management
• Arrival Management
• Pilgrim Tracking
• Tour Execution
• Incident Management
• Travel Completion

---

# 2. Business Purpose

This module transforms a confirmed booking into an executable travel plan.

Booking
↓
Travel Planning
↓
Flight Operations
↓
Hotel Operations
↓
Transport Operations
↓
Travel Execution
↓
Trip Completion
↓
Customer Feedback

---

# 3. Responsibilities

Responsible For
✓ Travel Plans
✓ Flight Operations
✓ Hotel Operations
✓ Room Allocation
✓ Transportation
✓ Daily Itinerary
✓ Checklists
✓ Group Management
✓ Departure Control
✓ Arrival Control
✓ Incident Tracking
✓ Traveler Attendance
✓ Trip Completion

Not Responsible For
✗ Customer Management
✗ Booking Creation
✗ Visa Processing
✗ Accounting
✗ Authentication

---

# 4. Travel Lifecycle

Planning
↓
Ready
↓
Departure Scheduled
↓
Checked In
↓
In Transit
↓
Arrived
↓
Hotel Checked In
↓
Tour Active
↓
Tour Completed
↓
Return Journey
↓
Completed

Possible Exceptions
↓
Delayed
↓
Cancelled
↓
Emergency
↓
Medical Assistance
↓
Lost Traveler
↓
Missed Flight

Travel workflow is configurable.

---

# 5. Travel Types

Umrah
Hajj
International Tour
Domestic Tour
Corporate Travel
Business Visit
Educational Tour
VIP Travel
Custom Travel

---

# 6. Aggregate Structure

Travel Plan
│
├── Booking
├── Travelers
├── Flights
├── Hotels
├── Rooms
├── Transport
├── Itinerary
├── Daily Activities
├── Checklists
├── Incidents
├── Attendance
├── Documents
├── Notes
├── Timeline
├── Tasks
└── Workflow

Travel Plan is the Aggregate Root.

---

# 7. Relationships

Travel Plan
↓
Booking
↓
Traveler
↓
Flight
↓
Hotel
↓
Transport
↓
Guide
↓
Driver
↓
Vehicle
↓
Daily Schedule
↓
Incidents
↓
Tasks
↓
Timeline

---

# 8. Travel Roles

Operations Manager
Travel Coordinator
Tour Guide
Driver
Hotel Coordinator
Airport Coordinator
Visa Officer
Finance Officer
Branch Manager
Administrator

---

# 9. API Inventory

GET /travel-plans
POST /travel-plans
GET /travel-plans/{travelPlanId}
PATCH /travel-plans/{travelPlanId}
POST /travel-plans/{travelPlanId}/travelers
POST /travel-plans/{travelPlanId}/flights
POST /travel-plans/{travelPlanId}/hotels
POST /travel-plans/{travelPlanId}/rooms
POST /travel-plans/{travelPlanId}/transport
POST /travel-plans/{travelPlanId}/itinerary
GET /travel-plans/{travelPlanId}/attendance
POST /travel-plans/{travelPlanId}/attendance
POST /travel-plans/{travelPlanId}/incidents
GET /travel-plans/{travelPlanId}/timeline
POST /travel-plans/{travelPlanId}/notes
GET /travel-plans/dashboard
GET /travel-plans/search

The following sections define each endpoint.

---

End Module Foundation

🏗 Enterprise Architecture
Travel Plan
│
├── Booking Snapshot
│
├── Traveler Snapshots
│
├── Flight Assignments
│
├── Hotel Assignments
│
├── Room Assignments
│
├── Transport Assignments
│
├── Daily Itinerary
│
├── Attendance
│
├── Incidents
│
├── Checklists
│
├── Notes
│
├── Timeline
│
├── Tasks
│
├── Notifications
│
└── Workflow

🏛 Senior Enterprise Improvement (Important)

One improvement I'd make before implementing the CRUD APIs is to distinguish Travel Plan from Travel Execution.

Many systems mix planning data with live operational data, which becomes difficult to manage.

Instead:

Travel Plan
│
├── Planned Flights
├── Planned Hotels
├── Planned Transport
├── Planned Itinerary
└── Planned Travelers
        │
        ▼
Travel Execution
│
├── Actual Flight Times
├── Actual Hotel Check-in
├── Actual Hotel Check-out
├── Actual Bus Departure
├── Actual Attendance
├── Actual Incidents
├── GPS Checkpoints
└── Live Status

Why this separation?
Suppose:
Flight was scheduled for 10:00 AM but departed at 12:15 PM.
Hotel check-in was planned for 2:00 PM but happened at 5:30 PM.

If you overwrite the planned values, you lose valuable operational history.

By separating Plan and Execution:
Planned vs Actual comparisons become possible.
Delay analysis is accurate.
Operational KPIs improve.
AI can later identify recurring issues (late buses, delayed flights, hotel bottlenecks).
Historical reporting becomes much more reliable.

📊 Progress
07-travel-api.md

✅ Module Foundation
✅ Travel Plan CRUD
✅ Flight Operations
✅ Hotel Operations
✅ Transport Management
✅ Itinerary Management
✅ Attendance Management
✅ Incident Management

⬜ Notes
⬜ Timeline
⬜ Dashboard
⬜ Search
⬜ Final Architecture

Progress: ~90%

---

# Part 2 — Travel Plan CRUD APIs

## Endpoint Contract: GET /api/v1/travel-plans

### 10. Business Purpose
Returns a paginated list of travel plans.
Used by Operations Dashboard, Airport Team, Hotel Team, Tour Guides, Branch Managers, Management Dashboard, AI Operations Assistant.
Only travel plans belonging to the authenticated tenant are returned.

### 11. Business Workflow
User -> Open Travel Operations -> GET /travel-plans -> Validate JWT -> Validate Permission -> Apply Tenant Filter -> Apply Branch Filter -> Apply Search Filters -> Apply Pagination -> Return Travel Plans

### 12. Endpoint Information
- Method: GET
- Authentication: Required
- Authorization: Required
- Permission: travel.read
- Audit Logged: Optional
- Idempotent: Yes

### 13. Query Parameters
`page=1`, `pageSize=20`, `travelStatus=Ready`, `bookingId=UUID`, `departureDateFrom`, `departureDateTo`, `arrivalDateFrom`, `arrivalDateTo`, `travelType=Umrah`, `assignedCoordinator=UUID`, `branchId=UUID`, `sort=departureDate`, `order=asc`

### 14. Business Rules
- Only same tenant travel plans.
- Archived plans hidden by default unless requested.
- Maximum page size = 100.
- Supports indexed filtering.

---

## Endpoint Contract: POST /api/v1/travel-plans

### 16. Business Purpose
Creates a travel plan from a confirmed booking.
Travel plans cannot exist without a booking.

### Business Workflow
Confirmed Booking -> Create Travel Plan -> Validate Booking -> Copy Booking Snapshot -> Copy Traveler Snapshots -> Initialize Workflow -> Create Default Checklists -> Assign Coordinator -> Create Timeline -> Publish TravelPlanCreated -> Audit Log -> Return Success

### Request Example
```json
{
  "bookingId": "UUID",
  "departureDate": "2026-10-15",
  "arrivalDate": "2026-10-25",
  "travelCoordinatorId": "UUID"
}
```

### Validation Rules
- Booking Exists & Confirmed & Same Tenant
- Coordinator Exists (if provided)
- Departure Date Valid
- Arrival Date > Departure Date

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}

### Business Purpose
Returns the complete travel aggregate summary.
Read-only aggregate. Includes Header, Booking Summary, Traveler Summary, Flight Summary, Hotel Summary, Transport Summary, Checklist Summary, Attendance Summary, Incident Summary, Workflow Summary, Timeline Summary, Task Summary, Version History.

---

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}

### Business Purpose
Updates operational planning information.
- Editable Fields: Travel Coordinator, Departure Date/Time, Arrival Date/Time, Priority, Internal Remarks, Assigned Team, Emergency Contact, Status.
- Non-editable: Travel Plan Number, Booking ID, Tenant ID, Created Date, Traveler Snapshots.
- Employs Travel Plan Versioning for operational audit.

---

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/archive

### Business Purpose
Archives completed travel plans. Plans are never permanently deleted. Operational & timeline history preserved.

---

# Part 3 — Flight Operations APIs

## Flight Architecture & Lifecycles
- Flight Catalog -> Travel Flight Assignment -> Traveler Flight Assignment -> Flight Execution -> Flight Completion
- Allowed Lifecycles: Scheduled, Confirmed, Ticket Issued, Check-in Open, Checked In, Boarding, Departed, In Flight, Arrived, Completed.
- Exceptions: Delayed, Cancelled, Missed Flight, Rescheduled, Diversion, Emergency.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/flights
- Method: GET
- Returns all flight assignments associated with the travel plan.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/flights
- Method: POST
- Assigns one or more flights to a travel plan. Validates travel plan and flight catalog/leg data.
- Domain Events: `FlightAssigned`, `FlightWorkflowInitialized`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}
- Method: PATCH
- Updates operational flight information (Times, Terminal, Gate, Remarks, Priority, Internal Notes).
- Domain Events: `FlightUpdated`, `FlightRescheduled`, `GateChanged`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}/travelers
- Method: POST
- Assigns travelers to a flight assignment in bulk.
- Domain Events: `TravelerAssignedToFlight`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}/status
- Method: PATCH
- Updates live flight execution status (`Departed`, `Arrived`, `In Flight`, `Boarding`, `Delayed`, etc.) and stores actual departure/arrival times.
- Domain Events: `FlightStatusUpdated`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}/incidents
- Method: POST
- Reports flight incidents (Missed Flight, Lost Baggage, Medical Emergency, Gate Change, Boarding Denied, Flight Cancelled).

---

## Supplier Integration Layer Architecture
- Abstracts supplier interaction via common provider adapters: `AirlineConnector`, `HotelConnector`, `TransportConnector`.

---

# Part 4 — Hotel Operations APIs

## Hotel Architecture & Room Inventory
- Hotel Catalog -> Room Inventory -> Travel Hotel Assignment -> Room Allocation -> Traveler Room Assignment -> Hotel Execution -> Hotel Completion
- Allowed Lifecycles: Planned, Reserved, Confirmed, Ready For Check-in, Checked In, Occupied, Checked Out, Completed.
- Exceptions: Delayed Check-in, Room Change, Overbooking, Cancelled, Maintenance Issue, Emergency.
- Meal Plans: Room Only, Breakfast, Half Board, Full Board, All Inclusive, Custom.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/hotels
- Method: GET
- Returns all assigned hotels, room allocations, occupancy stats, and meal plans.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/hotels
- Method: POST
- Assigns hotel(s) to a travel plan with planned check-in / check-out dates.
- Domain Events: `HotelAssigned`, `HotelWorkflowInitialized`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/hotels/{hotelAssignmentId}
- Method: PATCH
- Updates hotel assignment operational details (dates, meal plan, remarks, priority).
- Domain Events: `HotelUpdated`, `HotelRescheduled`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/rooms
- Method: POST
- Allocates rooms (Quad, Triple, Double, Single, Suite), checks capacity, and assigns travelers to rooms.
- Domain Events: `RoomAssigned`, `TravelerRoomAssigned`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/hotels/{hotelAssignmentId}/status
- Method: PATCH
- Updates live hotel execution status (`Checked In`, `Occupied`, `Checked Out`, `Completed`, etc.) and stores actual check-in/out timestamps.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/hotels/{hotelAssignmentId}/incidents
- Method: POST
- Reports hotel incidents (Room Not Ready, Lost Key, Medical Emergency, Room Damage, Maintenance Issue, Housekeeping Issue, Food Complaint).

---

# Part 5 — Transport Management APIs

## Transport Architecture & Journey Segments
- Fleet Catalog -> Vehicle Assignment -> Driver Assignment -> Route Assignment -> Traveler Assignment -> Trip Execution -> Trip Completion
- Employs **Journey Segments** (Airport -> Hotel, Hotel -> Haram, Makkah -> Madinah, Hotel -> Airport).
- Allowed Lifecycles: Planned, Vehicle Assigned, Driver Assigned, Route Confirmed, Ready, Boarding, Departed, In Transit, Arrived, Completed.
- Exceptions: Delayed, Vehicle Breakdown, Driver Changed, Route Changed, Traffic Delay, Emergency, Cancelled.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/transport
- Method: GET
- Returns all transport assignments and journey segments for a travel plan.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/transport
- Method: POST
- Assigns transport resources & journey segment to a travel plan. Validates vehicle, driver, route availability & capacity.
- Domain Events: `TransportAssigned`, `VehicleAssigned`, `DriverAssigned`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/transport/{transportAssignmentId}/travelers
- Method: POST
- Assigns travelers to a transport journey segment with capacity checks.
- Domain Events: `TravelerAssignedToTransport`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/transport/{transportAssignmentId}/status
- Method: PATCH
- Updates live transport execution status (`Boarding`, `Departed`, `In Transit`, `Arrived`, `Completed`, `Delayed`, `Breakdown`, etc.) and records actual departure/arrival timestamps.
- Domain Events: `TransportStatusUpdated`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/transport/{transportAssignmentId}/incidents
- Method: POST
- Reports transport incidents (Vehicle Breakdown, Flat Tire, Heavy Traffic, Road Closure, Medical Emergency, Traveler Missing, Driver Illness, Police Checkpoint, Accident).

---

# Part 6 — Itinerary Management APIs

## Itinerary Architecture & DAG Dependencies
- Travel Plan -> Day -> Activity -> Traveler Assignment -> Execution -> Completion
- Employs **Directed Activity Graph (DAG)** with automatic delay propagation across prerequisite/dependent activities.
- Activity Lifecycles: Draft, Planned, Published, In Progress, Completed, Delayed, Cancelled, Skipped, Rescheduled, Emergency.
- Activity Types: Airport, Flight, Hotel, Transport, Meal, Prayer, Ziyarat, Shopping, Meeting, Rest, Medical, Custom.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/itinerary
- Method: GET
- Returns ordered day-by-day sequence of itinerary activities with resources and status.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/itinerary
- Method: POST
- Creates itinerary activity/activities (supports bulk creation & DAG dependency definition).
- Domain Events: `ItineraryCreated`, `ActivityScheduled`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/itinerary/{activityId}
- Method: PATCH
- Updates activity details (planned times, guide, vehicle, hotel, location, remarks) and triggers automatic DAG delay propagation.
- Domain Events: `ActivityUpdated`, `ActivityRescheduled`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/itinerary/{activityId}/travelers
- Method: POST
- Bulk assigns travelers to an itinerary activity.

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/itinerary/{activityId}/status
- Method: PATCH
- Live activity execution status update (`In Progress`, `Completed`, `Delayed`, `Skipped`, etc.) capturing actual start/end timestamps.

---

# Part 7 — Attendance Management APIs

## Attendance Architecture & Presence Policy Engine
- Travel Plan -> Itinerary Activity -> Attendance Session -> Traveler Attendance -> Analytics
- Employs **Attendance Policy Engine** evaluating late thresholds (10 min), missing thresholds (20 min), and immediate emergency notifications.
- Attendance Statuses: Present, Checked In, Checked Out, Late, Absent, Excused, Emergency, Missing.
- Verification Methods: Manual, QR Code, NFC, Barcode, GPS, Biometric, Mobile App.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/attendance
- Method: GET
- Returns attendance records for a travel plan filtered by `activityId`, `day`, `travelerId`, `status`.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/attendance
- Method: POST
- Creates an attendance session for an itinerary activity, opening the check-in window.
- Domain Events: `AttendanceSessionCreated`, `AttendanceWindowOpened`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/attendance/{attendanceId}
- Method: PATCH
- Records/updates traveler attendance status, verification method, and evaluates late/missing/emergency rules.
- Domain Events: `AttendanceRecorded`, `TravelerMarkedLate`, `TravelerMarkedMissing`, `EmergencyReported`

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/attendance/dashboard
- Method: GET
- Returns attendance analytics (Expected, Present, Checked In, Checked Out, Late, Absent, Excused, Missing, Emergency, Completion Percentage).

---

# Part 8 — Incident Management APIs

## Incident Architecture & Case Management System (CAPA)
- Travel Plan -> Operational Module -> Incident -> Investigation -> Case Management -> Resolution -> CAPA -> Review
- Source Modules: Flight, Hotel, Transport, Attendance, Visa, Finance, Customer, Supplier, Guide, Driver, Operations, AI Monitoring.
- Categories: Medical, Security, Transport, Hotel, Flight, Immigration, Visa, Payment, Customer Complaint, Lost Passport, Lost Luggage, Traveler Missing, Natural Disaster, Operational Delay, Supplier Failure, Technical Issue.
- Severities: Low, Medium, High, Critical, Emergency.

---

## Endpoint Contract: GET /api/v1/incidents
- Method: GET
- Returns incidents visible to authenticated tenant with filters (`travelPlanId`, `category`, `severity`, `status`, `assignedTo`, `reportedBy`, `dateFrom`, `dateTo`, `page`, `pageSize`).

## Endpoint Contract: POST /api/v1/incidents
- Method: POST
- Creates a new operational incident, auto-generates `incidentNumber`, assigns workflow, and notifies operations.
- Domain Events: `IncidentCreated`, `EmergencyIncidentReported`

## Endpoint Contract: GET /api/v1/incidents/{incidentId}
- Method: GET
- Returns complete incident case details (Header, Travel Plan, Reporter, Assignee, Timeline, Attachments, Comments, Tasks, Resolution, CAPA).

## Endpoint Contract: PATCH /api/v1/incidents/{incidentId}
- Method: PATCH
- Updates incident details (`severity`, `priority`, `assignee`, `status`, `rootCause`, `correctiveAction`, `remarks`).
- Domain Events: `IncidentUpdated`, `IncidentEscalated`, `IncidentReopened`

## Endpoint Contract: POST /api/v1/incidents/{incidentId}/assign
- Method: POST
- Assigns incident to a user/team (`userId`, `team`).
- Domain Events: `IncidentAssigned`

## Endpoint Contract: POST /api/v1/incidents/{incidentId}/resolve
- Method: POST
- Resolves an incident (`resolutionSummary`, `rootCause`, `correctiveAction`, `preventiveAction`).
- Domain Events: `IncidentResolved`

## Endpoint Contract: POST /api/v1/incidents/{incidentId}/attachments
- Method: POST
- Uploads/associates attachment metadata (`name`, `url`, `mimeType`, `size`).

---

## Unified Activity Stream Architecture
- Centralizes domain events across Booking, Travel, Visa, Finance, and Incidents into a single chronological stream.


---

# Part 3 — Flight Operations APIs

## Flight Architecture & Lifecycles
- Flight Catalog -> Travel Flight Assignment -> Traveler Flight Assignment -> Flight Execution -> Flight Completion
- Allowed Lifecycles: Scheduled, Confirmed, Ticket Issued, Check-in Open, Checked In, Boarding, Departed, In Flight, Arrived, Completed.
- Exceptions: Delayed, Cancelled, Missed Flight, Rescheduled, Diversion, Emergency.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/flights
- Method: GET
- Returns all flight assignments associated with the travel plan.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/flights
- Method: POST
- Assigns one or more flights to a travel plan. Validates travel plan and flight catalog/leg data.
- Domain Events: `FlightAssigned`, `FlightWorkflowInitialized`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}
- Method: PATCH
- Updates operational flight information (Times, Terminal, Gate, Remarks, Priority, Internal Notes).
- Domain Events: `FlightUpdated`, `FlightRescheduled`, `GateChanged`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}/travelers
- Method: POST
- Assigns travelers to a flight assignment in bulk.
- Domain Events: `TravelerAssignedToFlight`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}/status
- Method: PATCH
- Updates live flight execution status (`Departed`, `Arrived`, `In Flight`, `Boarding`, `Delayed`, etc.) and stores actual departure/arrival times.
- Domain Events: `FlightStatusUpdated`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/flights/{flightAssignmentId}/incidents
- Method: POST
- Reports flight incidents (Missed Flight, Lost Baggage, Medical Emergency, Gate Change, Boarding Denied, Flight Cancelled).

---

## Supplier Integration Layer Architecture
- Abstracts supplier interaction via common provider adapters: `AirlineConnector`, `HotelConnector`, `TransportConnector`.

---

# Part 4 — Hotel Operations APIs

## Hotel Architecture & Room Inventory
- Hotel Catalog -> Room Inventory -> Travel Hotel Assignment -> Room Allocation -> Traveler Room Assignment -> Hotel Execution -> Hotel Completion
- Allowed Lifecycles: Planned, Reserved, Confirmed, Ready For Check-in, Checked In, Occupied, Checked Out, Completed.
- Exceptions: Delayed Check-in, Room Change, Overbooking, Cancelled, Maintenance Issue, Emergency.
- Meal Plans: Room Only, Breakfast, Half Board, Full Board, All Inclusive, Custom.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/hotels
- Method: GET
- Returns all assigned hotels, room allocations, occupancy stats, and meal plans.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/hotels
- Method: POST
- Assigns hotel(s) to a travel plan with planned check-in / check-out dates.
- Domain Events: `HotelAssigned`, `HotelWorkflowInitialized`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/hotels/{hotelAssignmentId}
- Method: PATCH
- Updates hotel assignment operational details (dates, meal plan, remarks, priority).
- Domain Events: `HotelUpdated`, `HotelRescheduled`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/rooms
- Method: POST
- Allocates rooms (Quad, Triple, Double, Single, Suite), checks capacity, and assigns travelers to rooms.
- Domain Events: `RoomAssigned`, `TravelerRoomAssigned`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/hotels/{hotelAssignmentId}/status
- Method: PATCH
- Updates live hotel execution status (`Checked In`, `Occupied`, `Checked Out`, `Completed`, etc.) and stores actual check-in/out timestamps.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/hotels/{hotelAssignmentId}/incidents
- Method: POST
- Reports hotel incidents (Room Not Ready, Lost Key, Medical Emergency, Room Damage, Maintenance Issue, Housekeeping Issue, Food Complaint).

---

# Part 5 — Transport Management APIs

## Transport Architecture & Journey Segments
- Fleet Catalog -> Vehicle Assignment -> Driver Assignment -> Route Assignment -> Traveler Assignment -> Trip Execution -> Trip Completion
- Employs **Journey Segments** (Airport -> Hotel, Hotel -> Haram, Makkah -> Madinah, Hotel -> Airport).
- Allowed Lifecycles: Planned, Vehicle Assigned, Driver Assigned, Route Confirmed, Ready, Boarding, Departed, In Transit, Arrived, Completed.
- Exceptions: Delayed, Vehicle Breakdown, Driver Changed, Route Changed, Traffic Delay, Emergency, Cancelled.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/transport
- Method: GET
- Returns all transport assignments and journey segments for a travel plan.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/transport
- Method: POST
- Assigns transport resources & journey segment to a travel plan. Validates vehicle, driver, route availability & capacity.
- Domain Events: `TransportAssigned`, `VehicleAssigned`, `DriverAssigned`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/transport/{transportAssignmentId}/travelers
- Method: POST
- Assigns travelers to a transport journey segment with capacity checks.
- Domain Events: `TravelerAssignedToTransport`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/transport/{transportAssignmentId}/status
- Method: PATCH
- Updates live transport execution status (`Boarding`, `Departed`, `In Transit`, `Arrived`, `Completed`, `Delayed`, `Breakdown`, etc.) and records actual departure/arrival timestamps.
- Domain Events: `TransportStatusUpdated`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/transport/{transportAssignmentId}/incidents
- Method: POST
- Reports transport incidents (Vehicle Breakdown, Flat Tire, Heavy Traffic, Road Closure, Medical Emergency, Traveler Missing, Driver Illness, Police Checkpoint, Accident).

---

# Part 6 — Itinerary Management APIs

## Itinerary Architecture & DAG Dependencies
- Travel Plan -> Day -> Activity -> Traveler Assignment -> Execution -> Completion
- Employs **Directed Activity Graph (DAG)** with automatic delay propagation across prerequisite/dependent activities.
- Activity Lifecycles: Draft, Planned, Published, In Progress, Completed, Delayed, Cancelled, Skipped, Rescheduled, Emergency.
- Activity Types: Airport, Flight, Hotel, Transport, Meal, Prayer, Ziyarat, Shopping, Meeting, Rest, Medical, Custom.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/itinerary
- Method: GET
- Returns ordered day-by-day sequence of itinerary activities with resources and status.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/itinerary
- Method: POST
- Creates itinerary activity/activities (supports bulk creation & DAG dependency definition).
- Domain Events: `ItineraryCreated`, `ActivityScheduled`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/itinerary/{activityId}
- Method: PATCH
- Updates activity details (planned times, guide, vehicle, hotel, location, remarks) and triggers automatic DAG delay propagation.
- Domain Events: `ActivityUpdated`, `ActivityRescheduled`

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/itinerary/{activityId}/travelers
- Method: POST
- Bulk assigns travelers to an itinerary activity.

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/itinerary/{activityId}/status
- Method: PATCH
- Live activity execution status update (`In Progress`, `Completed`, `Delayed`, `Skipped`, etc.) capturing actual start/end timestamps.

---

# Part 7 — Attendance Management APIs

## Attendance Architecture & Presence Policy Engine
- Travel Plan -> Itinerary Activity -> Attendance Session -> Traveler Attendance -> Analytics
- Employs **Attendance Policy Engine** evaluating late thresholds (10 min), missing thresholds (20 min), and immediate emergency notifications.
- Attendance Statuses: Present, Checked In, Checked Out, Late, Absent, Excused, Emergency, Missing.
- Verification Methods: Manual, QR Code, NFC, Barcode, GPS, Biometric, Mobile App.

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/attendance
- Method: GET
- Returns attendance records for a travel plan filtered by `activityId`, `day`, `travelerId`, `status`.

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/attendance
- Method: POST
- Creates an attendance session for an itinerary activity, opening the check-in window.
- Domain Events: `AttendanceSessionCreated`, `AttendanceWindowOpened`

## Endpoint Contract: PATCH /api/v1/travel-plans/{travelPlanId}/attendance/{attendanceId}
- Method: PATCH
- Records/updates traveler attendance status, verification method, and evaluates late/missing/emergency rules.
- Domain Events: `AttendanceRecorded`, `TravelerMarkedLate`, `TravelerMarkedMissing`, `EmergencyReported`

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/attendance/dashboard
- Method: GET
- Returns attendance analytics (Expected, Present, Checked In, Checked Out, Late, Absent, Excused, Missing, Emergency, Completion Percentage).

---

# Part 9 — Notes & Timeline APIs

## Overview

The Notes & Timeline module provides a centralized activity history and collaboration system for every Travel Plan.

Every important business action automatically creates an immutable timeline event. Users can also create editable collaboration notes.

This module answers the core enterprise question: **"What happened, who did it, and when did it happen?"**

---

## Canonical Domain Event Architecture

```
Travel Plan
    ↓
Timeline Engine
    │
    ├── System Events (Immutable)
    ├── User Notes (Editable with history)
    ├── Attachments (Images, Videos, PDFs, Medical Reports, Voice Notes)
    ├── Mentions (@Staff / Teams)
    ├── AI Events (Suggestions, Risk Warnings, Predictive Delays)
    └── Audit References (Correlation ID, Causation ID)
```

---

## Timeline Sources

- Booking
- Flight Operations
- Hotel Operations
- Transport Management
- Itinerary Management
- Attendance Management
- Visa Processing
- Finance & Accounting
- Customer Communication
- Incident Management
- AI Assistant & Predictive Engine
- Workflow Engine
- Authentication & Security
- System Scheduler

---

## Timeline Event Types

- `Created`, `Updated`, `Assigned`, `Cancelled`, `Approved`, `Rejected`
- `Checked In`, `Checked Out`, `Completed`, `Payment Received`, `Invoice Generated`
- `Traveler Added`, `Traveler Removed`, `Document Uploaded`, `Incident Reported`
- `Task Created`, `Task Completed`, `Notification Sent`, `AI Suggestion Generated`
- `Workflow Changed`, `Custom`

---

# Endpoint Contracts

---

## Endpoint Contract: GET /api/v1/travel-plans/{travelPlanId}/timeline

### 10. Business Purpose
Returns the complete chronological history for a travel plan using the Canonical Domain Event Model.

### 11. Query Parameters
- `page`: Integer (default: 1)
- `pageSize`: Integer (default: 20, max: 100)
- `eventType`: String (Filter by event type)
- `module`: String (Filter by source module)
- `userId`: String (Filter by actor ID)
- `visibility`: String (`Internal`, `Operations`, `Management`, `Customer Visible`, `Private`)
- `dateFrom`: ISO Date
- `dateTo`: ISO Date
- `search`: String (Keyword search across title & description)

### 12. Response Includes
- Event ID (`EVT-XXXXX`)
- Event Timestamp (`createdAt`)
- Source Module (`FlightOperations`, `IncidentManagement`, etc.)
- Event Type & Event Version
- Title & Description
- Actor details (User ID, Name, Role)
- Aggregate Type & Aggregate ID
- Visibility (`Internal`, `Operations`, `Management`, `Customer Visible`, `Private`)
- Correlation ID & Causation ID
- Attachments & Mentions
- AI Confidence Score (if generated by AI)

---

## Endpoint Contract: POST /api/v1/travel-plans/{travelPlanId}/notes

### 10. Business Purpose
Creates a collaboration note and automatically logs a canonical timeline event.

### 11. Request Example
```json
{
  "title": "Hotel Follow-up",
  "content": "Hotel manager confirmed early check-in for all 45 travelers at Makkah Clock Tower.",
  "visibility": "Internal",
  "mentions": [
    "usr_8822",
    "usr_9911"
  ]
}
```

### 12. Business Workflow
```
Validate User & Tenant
    ↓
Validate Travel Plan Exists
    ↓
Create Note Record (NTE-XXXXX)
    ↓
Log Canonical Domain Event (NoteCreated) to Timeline
    ↓
Notify Mentioned Users
    ↓
Audit Log
    ↓
Publish NoteCreated & UsersMentioned Events
    ↓
Return Success
```

---

## Endpoint Contract: PATCH /api/v1/notes/{noteId}

### 10. Business Purpose
Updates an existing collaboration note.

### 11. Editable Fields
- `title`
- `content`
- `visibility`
- `mentions`

### 12. Business Rules
- Only the original author or an authorized manager may edit.
- Full edit history is preserved in `editHistory` array.
- Logged to Timeline & Audit Log.
- Domain Events: `NoteUpdated`.

---

## Endpoint Contract: DELETE /api/v1/notes/{noteId}

### 10. Business Purpose
Soft-deletes a note. System events are immutable and cannot be deleted.

### 11. Business Rules
- Soft delete flag set to `true`.
- Audit mandatory.
- Domain Events: `NoteDeleted`.

---

## Endpoint Contract: POST /api/v1/timeline/{timelineEventId}/attachments

### 10. Business Purpose
Associates file metadata (Images, Videos, PDFs, Invoices, Tickets, Passports, Medical Reports, Voice Notes) stored in Object Storage with a timeline event.

---

# 🤖 AI Timeline Events

Examples of automated events published by the AI Engine:
- **`AITripDelayPredicted`**: AI predicted a 45-minute transport delay on Makkah-Madinah Highway based on real-time traffic data.
- **`AIHotelReassignmentSuggested`**: AI recommended overbooking mitigation by moving 4 rooms to Pullman Zamzam.
- **`AIOperationalSummaryGenerated`**: Daily operational digest generated with 98% confidence score.

---

# 🏛 Senior Enterprise Improvement — Canonical Domain Event Schema

```json
{
  "eventId": "EVT-88291a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
  "travelPlanId": "650c1f1e9b1e8a0012345678",
  "tenantId": "tenant_maqvera_01",
  "sourceModule": "TransportManagement",
  "aggregateType": "TransportAssignment",
  "aggregateId": "TRP-2026-0012",
  "eventType": "TransportStatusUpdated",
  "eventVersion": "1.0.0",
  "title": "Bus Departed for Madinah",
  "description": "Bus VIP-01 departed Makkah hotel with 45 travelers.",
  "actor": {
    "userId": "usr_772211",
    "name": "Tariq Mansoor",
    "role": "Driver"
  },
  "visibility": "Operations",
  "correlationId": "CORR-TP-2026-00082",
  "causationId": "EVT-77112233",
  "attachments": [],
  "mentions": [],
  "aiConfidenceScore": null,
  "isImmutable": true
}
```

---

# AI Coding Rules Summary

✓ Immutable Timeline  
✓ Editable Notes with Revision History  
✓ Mention System (@User Notifications)  
✓ Object Storage Metadata Integration  
✓ Soft Delete Policy  
✓ Canonical Domain Event Schema  
✓ Audit Logging & Tenant Isolation  

---

# Part 10 — Dashboard & Analytics APIs

## Overview

The Dashboard & Analytics module provides operational insights for travel execution.

Dashboards are strictly **read-only** and employ a **CQRS Read Model** architecture.

They **never** calculate metrics directly from transactional tables during user requests. Instead, they leverage precomputed summary tables (`TravelOperationsSummaryModel`), materialized read views, Redis cache, and background event listeners.

---

## Enterprise Dashboard Architecture

```
                        Dashboard Clients
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
 Operations Dashboard   Executive Dashboard   Guide Dashboard
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                      Analytics Engine
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
     Redis Cache      Materialized Views    Summary Tables
                             │
                      Background Workers
                             │
                       Domain Events
                             │
                   Transactional Database
```

---

## Centralized Analytics Engine

```
Analytics Engine
│
├── KPI Calculator (Computes operational metrics: On-time departure %, Incident rate, Utilization)
├── Trend Generator (Historical time-series across 7d, 30d, 90d, 1y)
├── Summary Builder (Assembles main operational dashboard metrics)
├── Widget Generator (Filters widgets by user role)
├── AI Insight Generator (Operational bottleneck warnings & predictive recommendations)
├── Cache Manager (Redis / In-memory multi-tenant caching with async background refresh)
└── Report Export Engine (Prepares BI data feeds for Metabase / PowerBI)
```

---

# Endpoint Contracts

---

## Endpoint Contract: GET /api/v1/travel/dashboard

### 10. Business Purpose
Returns the primary operational dashboard metrics.

### 11. Query Parameters
- `branchId`: String (Filter by branch, default: `all`)

### 12. Response Includes
- Active Travel Plans
- Today's Departures & Arrivals
- Travelers In Transit & Checked In
- Pending Check-ins & Delayed Flights
- Pending Hotel Check-ins & Transport Status
- Open Incidents, Critical Incidents, Emergency Cases
- Tasks Due Today, Upcoming Activities, Completed Activities
- Operational Health Score (0–100)
- AI Operational Insights
- Last Refresh Time

---

## Endpoint Contract: GET /api/v1/travel/dashboard/kpis

### 10. Business Purpose
Returns operational Key Performance Indicators calculated offline by the Analytics Engine.

### 11. Response Includes
- `onTimeDeparturePct`
- `onTimeArrivalPct`
- `hotelCheckInSuccessPct`
- `attendancePct`
- `travelerSatisfaction`
- `incidentRatePct`
- `emergencyCount`
- `tripCompletionPct`
- `avgDelay`
- `avgIncidentResolutionTime`
- `vehicleUtilization`

---

## Endpoint Contract: GET /api/v1/travel/dashboard/trends

### 10. Business Purpose
Returns historical time-series metrics.

### 11. Supported Periods
- `Today`
- `Yesterday`
- `7 Days`
- `30 Days`
- `90 Days`
- `1 Year`
- `Custom`

---

## Endpoint Contract: GET /api/v1/travel/dashboard/map

### 10. Business Purpose
Returns live operational geographic map data including airport locations, hotel occupancy clusters, transport routes, incident locations, and emergency alerts.

---

## Endpoint Contract: GET /api/v1/travel/dashboard/workload

### 10. Business Purpose
Returns operational workload distribution across Travel Coordinators, Tour Guides, open tasks, and pending approvals.

---

## Endpoint Contract: GET /api/v1/travel/dashboard/alerts

### 10. Business Purpose
Returns real-time operational alerts (Flight Delays, Transport Issues, Low Attendance, High Priority Incidents, Weather Warnings).

---

# AI Coding Rules Summary

✓ CQRS Read Model  
✓ Redis Cache First  
✓ Precomputed Summary Tables & Materialized Views  
✓ Async Background Refresh (Never lock transactional tables)  
✓ Centralized Analytics Engine  
✓ Multi-Tenant & Branch Isolation  
✓ Read-Only Analytics  

---

# Part 11 — Enterprise Search APIs

## Overview

The Enterprise Search module provides a centralized search engine across all Travel Operations & ERP data.

Instead of searching module by module, users perform one search that returns all related entities (Travel Plans, Bookings, Customers, Travelers, Flights, Hotels, Transport, Activities, Attendance, Incidents, Tasks, Notes, Timeline, Documents, Visa).

---

## Enterprise Search Architecture

```
                        User Request
                             │
                             ▼
                     Global Search API
                             │
                             ▼
                    Search Orchestrator
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
 Permission Filter     Tenant Filter        Branch Filter
        │
        ▼
                Search Index Engine
        │
 ┌──────┼────────────┬─────────────┬─────────────┐
 ▼      ▼            ▼             ▼             ▼
Travel Booking   Customer      Incident       Timeline
        │
        ▼
   Result Ranker (Exact > Prefix > Contains > Fuzzy)
        │
        ▼
  Response Builder
        │
        ▼
     Client
```

---

## Dedicated Search Index Service Architecture

```
Booking / Customer / Incident / Travel Event
        │
        ▼
   Domain Event
        │
        ▼
Search Index Worker (Background Async)
        │
        ▼
   Search Index (`SearchIndexModel`)
        │
        ▼
Fast Full-Text Queries (No Transactional Table Scanning)
```

---

# Endpoint Contracts

---

## Endpoint Contract: GET /api/v1/search

### 10. Business Purpose
Performs global search across all authorized ERP entities.

### 11. Query Parameters
- `q`: String (Search query text, e.g. "Ahmed", "INC-2026-00001", "SV-112")
- `page`: Integer (default: 1)
- `pageSize`: Integer (default: 20, max: 100)
- `entityType`: String (`TravelPlan`, `Booking`, `Customer`, `Traveler`, `Flight`, `Hotel`, `Transport`, `Incident`, `Task`, `Note`, `Document`, `Visa`)
- `branchId`: String (default: `all`)
- `sort`: String (default: `score`)
- `order`: String (`desc` | `asc`)

### 12. Response Includes
- `entityType`
- `entityId`
- `title`
- `description`
- `matchedField`
- `module`
- `status`
- `navigationUrl`
- `score` (0–100 relevance score)

### 13. Example Response
```json
{
  "success": true,
  "data": [
    {
      "entityType": "Traveler",
      "entityId": "650c1f1e9b1e8a0012345699",
      "title": "Ahmed Ali",
      "description": "Traveler on TP-2026-00082",
      "matchedField": "Passport Number",
      "module": "TravelOperations",
      "status": "In Transit",
      "navigationUrl": "/travelers/650c1f1e9b1e8a0012345699",
      "score": 98
    },
    {
      "entityType": "Incident",
      "entityId": "650c1f1e9b1e8a0012345610",
      "title": "[High] Traveler experienced severe illness",
      "description": "Traveler Ahmed Ali reported ill on bus transfer.",
      "matchedField": "Description",
      "module": "IncidentManagement",
      "status": "in_investigation",
      "navigationUrl": "/incidents/650c1f1e9b1e8a0012345610",
      "score": 94
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 2,
    "totalPages": 1,
    "isFallback": false
  }
}
```

---

## Endpoint Contract: GET /api/v1/search/suggestions

### 10. Business Purpose
Returns suggested searches, recent searches, popular search terms, and frequently accessed records.

---

## Endpoint Contract: POST /api/v1/search/saved

### 10. Business Purpose
Saves a complex query filter for reuse by operational staff and managers.

---

# Search Ranking Algorithm

```
Exact Match (Score = 100)
    ↓
Prefix Match (Score = 90)
    ↓
Contains Match (Score = 75)
    ↓
Phonetic & Fuzzy Match (Score = 60)
```

---

# AI Coding Rules Summary

✓ Dedicated Search Index Engine  
✓ Domain Event Index Syncing  
✓ Multi-Tenant Isolation  
✓ Branch Filtering  
✓ Multi-level Relevance Ranking  
✓ Zero Transactional Lock  
✓ Future ElasticSearch / OpenSearch Adapter Ready  

---

# Part 12 — Final Enterprise Architecture

---

## 1. Module Responsibilities

The Travel Operations module executes a confirmed travel booking.

### Responsible For:
✓ Travel Plan Management  
✓ Flight Operations  
✓ Hotel Operations  
✓ Room Allocation  
✓ Transport Operations  
✓ Itinerary Execution  
✓ Attendance Tracking  
✓ Incident Management  
✓ Notes & Timeline  
✓ Dashboard & Analytics  
✓ Enterprise Search  

### Not Responsible For:
✗ Customer Management (Customer Bounded Context)  
✗ Booking Creation (Booking Bounded Context)  
✗ Authentication (Identity Bounded Context)  
✗ Finance Accounting (Finance Bounded Context)  
✗ Visa Processing (Visa Bounded Context)  

---

## 2. Bounded Context Diagram

```
Travel Operations Bounded Context
│
├── Travel Plans
├── Flight Operations
├── Hotel Operations
├── Transport Operations
├── Itinerary
├── Attendance
├── Incident Management
├── Timeline
└── Analytics
```

---

## 3. Aggregate Roots

- **`TravelPlan`**: Aggregate root for operational execution plan.
- **`FlightAssignment`**: Aggregate root for operational flight legs.
- **`HotelAssignment`**: Aggregate root for hotel stays & room allocations.
- **`TransportAssignment`**: Aggregate root for vehicle & route assignments.
- **`ItineraryActivity`**: Aggregate root for DAG activities.
- **`AttendanceSession`**: Aggregate root for presence tracking sessions.
- **`Incident`**: Aggregate root for operational cases & CAPA.
- **`TimelineEvent`**: Aggregate root for canonical domain events.

*Rule: Never mutate child entities directly. Always mutate through the Aggregate Root.*

---

## 4. Module Dependency Graph

```
Authentication
      ↓
Identity
      ↓
Customer
      ↓
Booking
      ↓
Finance
      ↓
Visa
      ↓
Travel Operations (Consumes Upstream Data, Publishes Downstream Domain Events)
      ↓
Communication
      ↓
Reporting
      ↓
AI Assistant
```

---

## 5. Internal Component Architecture

```
Travel API / Router
      ↓
Controller Layer
      ↓
Application Services (AnalyticsEngine, SearchEngineService, TravelOrchestrationEngine)
      ↓
Domain Services & Aggregate Models (Mongoose Schemas)
      ↓
Database / Repository (MongoDB / PostgreSQL)
```

---

## 6. CQRS Architecture

```
Write Commands (Domain Events Published)
------------------------------------------
• Create Travel Plan
• Assign Flight / Hotel / Vehicle
• Record Attendance
• Report / Resolve Incident
• Create Note

Read Queries (Precomputed Read Models & Redis Caching)
------------------------------------------
• Travel Dashboard & Operational KPIs
• Enterprise Search Index
• Travel Timeline
• Attendance Dashboard
```

---

## 7. Business Process Orchestration Architecture

```
Travel Confirmed / Event
        │
        ▼
Travel Orchestrator (`TravelOrchestrationEngine.js`)
        │
        ├── Create Flight Tasks
        ├── Create Hotel Tasks
        ├── Create Transport Tasks
        ├── Generate Itinerary
        ├── Schedule Attendance
        ├── Update Dashboard Cache
        ├── Index Search Engine
        └── Notify AI Assistant & Ops Team
```

---

## 8. Domain Event Map

- `TravelPlanCreated`, `TravelPlanUpdated`, `TravelPlanCompleted`, `TravelPlanArchived`
- `FlightAssigned`, `FlightUpdated`, `FlightStatusUpdated`
- `HotelAssigned`, `HotelUpdated`, `RoomAssigned`
- `TransportAssigned`, `VehicleAssigned`, `DriverAssigned`, `TransportStatusUpdated`
- `ItineraryCreated`, `ActivityScheduled`, `ActivityUpdated`
- `AttendanceSessionCreated`, `AttendanceRecorded`, `TravelerMarkedLate`, `TravelerMarkedMissing`
- `IncidentCreated`, `EmergencyIncidentReported`, `IncidentAssigned`, `IncidentResolved`
- `NoteCreated`, `UsersMentioned`, `NoteUpdated`, `NoteDeleted`
- `SearchPerformed`, `SavedSearchCreated`

---

## 9. Security & Multi-Tenant Architecture

```
JWT Authentication
      ↓
Tenant Validation (`tenantId` mandatory filter)
      ↓
Branch Validation (`branchId` isolation)
      ↓
Permission Validation (RBAC & Policy Check)
      ↓
Business Validation
      ↓
API Execution
      ↓
Audit Logging
```

---

## 10. Scalability & Performance Strategy

- **CQRS & Redis Cache First**: Dashboard and search queries never hit transactional tables.
- **Asynchronous Background Processing**: Domain events handle indexing, notifications, and analytics cache invalidation.
- **Soft Delete Policy**: Data is never hard deleted (`isSoftDeleted: true`).
- **Object Storage Isolation**: Media files, medical reports, and documents stored in S3/Object Storage with DB metadata.

---

## 23. Production Readiness & Completion Summary

### Travel Operations API Status: **✅ COMPLETE**

| Parameter | Specification |
|---|---|
| **Document ID** | `API-007` |
| **Version** | `1.0.0` |
| **Implementation Status** | `Production Ready` |
| **Next Document** | `API-008 — Visa Management API` |

---

# AI Implementation Checklist

✓ Domain-Driven Design & Bounded Context Enforced  
✓ CQRS Read Model & Redis Caching  
✓ Event-Driven EventBus & Canonical Domain Event Schema  
✓ Multi-Tenant (`tenantId`) & Multi-Branch (`branchId`) Isolation  
✓ Case Management & CAPA Engine  
✓ Business Process Orchestration Layer (`TravelOrchestrationEngine.js`)  
✓ Standalone Enterprise Search Engine  
✓ 100% Production Ready  

