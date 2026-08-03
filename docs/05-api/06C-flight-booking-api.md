---
title: Flight Booking API
document_id: API-006C
version: 1.0.0
status: Production Approved
module: GDS Integration
---

# Flight Booking API

---

## 1. Overview

The Flight Booking module converts a live Flight Offer into a confirmed airline reservation by interacting with external Global Distribution Systems (GDS).

### Supported Providers
✓ Amadeus  
✓ Sabre  
✓ Travelport (Future)  
✓ Direct Airline APIs (Future)  

Unlike Flight Search, this module communicates directly with provider booking APIs to create a Passenger Name Record (PNR) and store a provider snapshot in the ERP.

---

## 2. Business Purpose

This module creates live airline reservations directly from the ERP without manual agent entry into GDS terminals.

```
Employee ──► Select Offer ──► Enter Passengers ──► Book Flight ──► GDS (Amadeus/Sabre) ──► PNR Created ──► ERP & Booking Updated
```

---

## 3. Responsibilities

### Responsible For:
✓ Offer Revalidation  
✓ Passenger Validation  
✓ Create PNR / Hold Booking  
✓ Confirm Booking  
✓ Retrieve Booking  
✓ Synchronize Provider Data  
✓ Booking Cancellation  
✓ Booking Status Lifecycle  
✓ Fare Lock Validation  
✓ Ticketing Preparation  

### Not Responsible For:
✗ Ticket Issuance (Flight Ticketing API API-006D)  
✗ Payments & Accounting (Finance Module)  
✗ Boarding Pass Generation (Airline DCS)  
✗ Travel Execution & Ground Logistics (Travel Operations Context)  

---

## 4. Booking Workflow Architecture

```
Selected Flight Offer
      │
      ▼
Offer Revalidation (Price & Seats)
      │
      ▼
Validate Passenger Passports & Details
      │
      ▼
Create PNR via Provider Adapter (Amadeus / Sabre)
      │
      ▼
Store Flight Booking Snapshot (`FlightBookingModel`)
      │
      ▼
Record Canonical Timeline & Audit Logs
      │
      ▼
Publish Domain Events (`FlightBookingCreated`, `PNRCreated`)
      │
      ▼
Return Reserved PNR Response
```

---

## 5. Booking Status Lifecycle

```
Offer Selected
      │
      ▼
Pending Validation
      │
      ▼
  Reserved (PNR Active, Awaiting Ticketing)
      │
      ├──► Awaiting Ticketing ──► Ticketed ──► Completed
      │
      └──► Cancelled / Expired / Rejected / Failed
```

---

## 6. API Inventory

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/flight-bookings` | Create live airline reservation (PNR) from offer |
| `GET` | `/api/v1/flight-bookings/:flightBookingId` | Get provider booking snapshot & details by ID |
| `POST` | `/api/v1/flight-bookings/revalidate` | Revalidate offer price & seat availability prior to booking |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/cancel` | Cancel airline reservation with provider |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/sync` | Sync live PNR status & schedule changes from provider |
| `GET` | `/api/v1/flight-bookings/:flightBookingId/history` | Retrieve booking audit & version history |

---

## Endpoint Contract: POST /api/v1/flight-bookings

### 1. Business Purpose
Creates a live airline reservation (PNR) from a validated Flight Offer.

### 2. Endpoint Information
- **Method**: `POST`
- **Path**: `/api/v1/flight-bookings`
- **Authentication**: Required (Bearer JWT)
- **Authorization**: Required (`flight.book`)
- **Audit Logged**: Mandatory (Idempotent)

### 3. Request Body Example
```json
{
  "offerId": "OFF-SV701-20270115",
  "bookingId": "650c1f1e9b1e8a0012345678",
  "provider": "Amadeus",
  "travelers": [
    {
      "firstName": "Ahmed",
      "lastName": "Ali",
      "gender": "Male",
      "dateOfBirth": "1994-05-20",
      "passportNumber": "AB123456",
      "passportExpiry": "2032-10-10",
      "nationality": "PK"
    }
  ],
  "contact": {
    "email": "customer@example.com",
    "phone": "+923001234567"
  }
}
```

### 4. Successful Response (HTTP 201 Created)
```json
{
  "success": true,
  "data": {
    "flightBookingId": "650c1f1e9b1e8a0012345999",
    "bookingId": "650c1f1e9b1e8a0012345678",
    "provider": "Amadeus",
    "providerBookingReference": "AMAD-PNR-78910",
    "pnr": "AMAD-PNR-78910",
    "status": "Reserved",
    "totalPrice": 145000,
    "currency": "PKR",
    "ticketingDeadline": "2027-01-14T23:59:59.000Z",
    "travelerCount": 1,
    "createdAt": "2026-07-29T01:11:00.000Z"
  }
}
```

---

## 7. Domain Events

- `FlightBookingCreated`
- `FlightBookingRevalidated`
- `FlightBookingCancelled`
- `ProviderBookingSynchronized`
- `PNRCreated`
- `PNRUpdated`
- `FlightBookingFailed`

---

## 8. AI Integration Guidelines

AI Assistant never issues bookings directly. AI capabilities:
✓ Explains fare rules & baggage conditions  
✓ Compares flight offers  
✓ Detects schedule conflicts  
✓ Recommends cheaper routes & dates  

*Rule: Human user confirmation is strictly required before issuing PNR creation requests.*

---

## 9. Completion Status

- **Status**: ✅ Production Ready
- **Document ID**: `API-006C`
- **Version**: `1.0.0`
- **Next Document**: `API-006D — Flight Ticketing & PNR Management`
