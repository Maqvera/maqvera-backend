---
title: Flight Ticketing & PNR Management API
document_id: API-006D
version: 1.0.0
status: Production Approved
module: GDS Integration
---

# Flight Ticketing & PNR Management API

---

## 1. Overview

The Flight Ticketing module manages airline Passenger Name Records (PNRs) after reservation.

It is responsible for electronic ticket issuance, ticket synchronization, voiding, reissuance/exchanges, refund preparation, SSR (Special Service Requests), OSI (Other Service Information), and EMD (Electronic Miscellaneous Documents).

Supported Providers:
✓ Amadeus  
✓ Sabre  
✓ Travelport (Future)  
✓ Direct Airline APIs (Future)  

---

## 2. Business Purpose

Converts airline PNR reservations into electronic e-tickets.

```
Flight Search ──► Flight Booking ──► PNR Created ──► Ticket Issued ──► Travel Operations ──► Completed
```

---

## 3. Responsibilities

### Responsible For:
✓ PNR Management & Full Snapshot  
✓ E-Ticket Issuance  
✓ Ticket Synchronization  
✓ Ticket Void  
✓ Ticket Exchange & Reissue  
✓ Ticket Refund Request Calculation  
✓ Schedule Change Handling  
✓ Ancillary Services & EMD Management  
✓ SSR (Special Service Requests)  
✓ OSI (Other Service Information)  

### Not Responsible For:
✗ Flight Search (Flight Search API API-006B)  
✗ Hotel Booking (Hotel APIs API-006E)  
✗ Payments & Refunds Payout (Finance Module)  
✗ Boarding Pass / Airport DCS Operations  

---

## 4. PNR & Ticket Lifecycle

```
Created ──► Reserved ──► Awaiting Payment ──► Ready For Ticketing ──► Ticketed ──► Travel Completed
                                                                       │
                                                   ┌───────────────────┼───────────────────┐
                                                   ▼                   ▼                   ▼
                                                Voided             Reissued         Refund Requested
```

---

## 5. API Inventory

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/flight-bookings/:flightBookingId/pnr` | Get complete PNR information, ticket numbers, SSR, OSI, & EMD |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/ticket` | Issue electronic airline tickets for PNR |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/void` | Void an issued ticket within airline void window |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/reissue` | Reissue/exchange ticket for new flight offer |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/refund` | Submit ticket refund request & calculate fees |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/sync` | Full PNR synchronization with GDS provider |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/ssr` | Add Special Service Requests (Wheelchair, Meal, Extra Seat) |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/osi` | Add Other Service Information (VIP, Corporate, Medical) |
| `POST` | `/api/v1/flight-bookings/:flightBookingId/emd` | Issue Electronic Miscellaneous Document (Baggage, Lounge) |

---

## Endpoint Contract: POST /api/v1/flight-bookings/:flightBookingId/ticket

### 1. Business Purpose
Issues electronic airline tickets for a confirmed PNR.

### 2. Request Body Example
```json
{
  "paymentReference": "PAY-20260729-001",
  "remarks": "Issue immediately"
}
```

### 3. Successful Response (HTTP 201 Created)
```json
{
  "success": true,
  "data": {
    "ticketStatus": "Issued",
    "ticketNumbers": [
      "0651234567890",
      "0651234567891"
    ],
    "issuedAt": "2027-01-15T08:45:00.000Z"
  }
}
```

---

## 6. SSR, OSI, and EMD Specifications

### Special Service Requests (SSR)
Supported types: `Wheelchair`, `Special Meal`, `Infant`, `Extra Seat`, `Medical`, `Pet`, `Unaccompanied Minor`.

### Other Service Information (OSI)
Supported types: `VIP Passenger`, `Language Preference`, `Special Handling`, `Corporate Traveler`, `Medical Notes`.

### Electronic Miscellaneous Documents (EMD)
Supported types: `Extra Baggage`, `Seat Upgrade`, `Lounge Access`, `Sports Equipment`, `Priority Boarding`, `Wi-Fi`.

---

## 7. Domain Events

- `TicketIssued`
- `TicketVoided`
- `TicketReissued`
- `RefundRequested`
- `SSRAdded`
- `OSIAdded`
- `EMDIssued`
- `TicketSynchronized`

---

## 8. AI Coding Rules Summary

✓ Provider Independent  
✓ Event-Driven Domain Event Bus  
✓ CQRS Ready Read/Write Separation  
✓ Immutable Ticket History  
✓ Circuit Breaker & Retry Policy  
✓ Audit Logging & Timeline Integration  
✓ Never expose provider DTOs directly  

---

## 9. Completion Status

- **Status**: ✅ Production Ready
- **Document ID**: `API-006D`
- **Version**: `1.0.0`
- **Next Document**: `API-006E — Hotel Distribution & Booking APIs`
