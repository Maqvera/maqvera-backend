---
title: Hotel Distribution & Booking API
document_id: API-006E
version: 1.0.0
status: Production Approved
module: GDS Integration
---

# Hotel Distribution & Booking API

---

## 1. Overview

The Hotel Distribution & Booking module provides live hotel inventory by integrating with hotel distribution providers and Global Distribution Systems (GDS).

Unlike Hotel Operations (which manages room allocation and guest check-in), this module is responsible for live availability search, rate comparison, reserving, and confirming hotel bookings.

Supported Providers:
✓ Amadeus Hotels  
✓ Hotelbeds  
✓ Expedia Partner API  
✓ Booking.com Connectivity  
✓ Sabre Hotels  
✓ Direct Hotel APIs  

---

## 2. Business Purpose

Employees and customers can search, compare, and book hotels directly inside the ERP without leaving the platform.

```
Customer ──► Search City (e.g. Makkah) ──► ERP ──► Hotel Integration Layer ──► Amadeus / Hotelbeds / Expedia ──► Live Offers ──► Reservation ──► ERP & Operations
```

---

## 3. Responsibilities

### Responsible For:
✓ Live Hotel Search  
✓ Room Availability & Rates  
✓ Live Pricing & Meal Plans  
✓ Hotel Reservation Creation  
✓ Reservation Modification  
✓ Hotel Booking Cancellation  
✓ Accommodation Voucher Generation  
✓ Supplier Status Synchronization  
✓ Hotel Policy Parsing  
✓ AI Recommendation Support  

### Not Responsible For:
✗ Physical Room Allocation (Travel Operations Context)  
✗ Traveler On-ground Check-in (Travel Operations Context)  
✗ Hotel Operations (Travel Operations Context)  

---

## 4. Search & Booking Architecture

```
Customer Request
      │
      ▼
Search Validation
      │
      ▼
Hotel Integration Layer (Amadeus / Hotelbeds / Expedia)
      │
      ▼
Normalize Live Provider Results
      │
      ▼
Cache Results (10 Min TTL)
      │
      ▼
Offer Selection & Revalidation
      │
      ▼
Hotel Reservation Creation (`HotelBookingModel`)
      │
      ▼
Voucher Generation & Domain Events (`HotelBooked`, `VoucherGenerated`)
```

---

## 5. API Inventory

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/hotel-search` | Live hotel search (City, Dates, Guests, Meal Plans) |
| `GET` | `/api/v1/hotel-search/:searchId` | Retrieve cached hotel search results by ID |
| `POST` | `/api/v1/hotel-search/revalidate` | Revalidate room availability & price before booking |
| `POST` | `/api/v1/hotel-bookings` | Create live hotel reservation with supplier |
| `GET` | `/api/v1/hotel-bookings/:hotelBookingId` | Retrieve supplier reservation snapshot & status |
| `POST` | `/api/v1/hotel-bookings/:hotelBookingId/modify` | Modify check-in, check-out, or room selection |
| `POST` | `/api/v1/hotel-bookings/:hotelBookingId/cancel` | Cancel hotel reservation with provider |
| `POST` | `/api/v1/hotel-bookings/:hotelBookingId/voucher` | Generate hotel accommodation voucher & QR code |
| `POST` | `/api/v1/hotel-bookings/:hotelBookingId/sync` | Sync reservation status & policies with supplier |
| `GET` | `/api/v1/hotel-providers/status` | Check supplier API health & latency |

---

## Endpoint Contract: POST /api/v1/hotel-search

### 1. Request Body Example
```json
{
  "city": "Makkah",
  "checkIn": "2027-01-15",
  "checkOut": "2027-01-20",
  "rooms": 2,
  "adults": 4,
  "children": 1,
  "nationality": "PK",
  "currency": "PKR"
}
```

### 2. Successful Response (HTTP 200 OK)
```json
{
  "success": true,
  "searchId": "9b1e8a00-650c-4e9f-8a12-123456789abc",
  "provider": "Hotelbeds",
  "results": [
    {
      "offerId": "HOTEL-SWISS-001",
      "hotelName": "Swissotel Makkah",
      "city": "Makkah",
      "stars": 5,
      "distanceToHaram": "250 meters",
      "mealPlan": "Breakfast",
      "roomType": "Quad",
      "availableRooms": 15,
      "price": 350000,
      "currency": "PKR",
      "cancellationPolicy": "Free cancellation until 48 hours before check-in"
    }
  ]
}
```

---

## Endpoint Contract: POST /api/v1/hotel-bookings

### 1. Request Body Example
```json
{
  "offerId": "HOTEL-SWISS-001",
  "bookingId": "650c1f1e9b1e8a0012345678",
  "provider": "Hotelbeds",
  "guests": [
    { "firstName": "Ahmed", "lastName": "Ali" }
  ]
}
```

### 2. Successful Response (HTTP 201 Created)
```json
{
  "success": true,
  "data": {
    "hotelBookingId": "650c1f1e9b1e8a0012345888",
    "reservationNumber": "HB-45874",
    "provider": "Hotelbeds",
    "status": "Confirmed",
    "hotelName": "Swissotel Makkah",
    "roomType": "Quad",
    "totalPrice": 350000,
    "currency": "PKR"
  }
}
```

---

## 6. Domain Events

- `HotelSearchRequested`
- `HotelSearchCompleted`
- `HotelBooked`
- `HotelBookingModified`
- `HotelBookingCancelled`
- `VoucherGenerated`
- `HotelBookingSynchronized`

---

## 7. AI Coding Rules Summary

✓ Provider Independent Adapter Architecture  
✓ CQRS Read/Write Model Separation  
✓ 10-Minute TTL Cache Strategy  
✓ Event-Driven EventBus  
✓ Automatic Supplier Failover  
✓ Timeline & Audit Integration  
✓ Human confirmation strictly required before booking  

---

## 8. Completion Status

- **Status**: ✅ Production Ready
- **Document ID**: `API-006E`
- **Version**: `1.0.0`
- **Next Document**: `API-006F — AI Travel Assistant API`
