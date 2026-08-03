---
title: Flight Search API
document_id: API-006B
version: 1.0.0
status: Production Approved
module: GDS Integration
---

# Flight Search API

---

## 1. Overview

The Flight Search module provides live airline inventory by integrating with external Global Distribution Systems (GDS).

### Supported Providers
✓ Amadeus  
✓ Sabre  
✓ Travelport (Future)  
✓ Direct Airline APIs (Future)  

Unlike traditional Flight Catalogs, this module does not rely on locally stored flight schedules. Every search retrieves live inventory directly from external providers.

---

## 2. Business Purpose

Employees and customers can search flights without leaving the ERP.

```
Employee ──► Search KHI ➔ JED ──► Travel ERP ──► GDS Integration Layer ──► Amadeus API ──► Live Results ──► ERP
```

No manual switching between external systems is required.

---

## 3. Responsibilities

### Responsible For:
✓ One-way Search  
✓ Round-trip Search  
✓ Multi-city Search  
✓ Seat Availability  
✓ Fare Search  
✓ Cabin Availability  
✓ Airline Filtering  
✓ Baggage Information  
✓ Fare Rules  
✓ Layover Information  
✓ Flight Duration  
✓ Live Pricing  
✓ Currency Conversion  
✓ AI Search Support  

### Not Responsible For:
✗ Ticket Issuance (Flight Booking API)  
✗ Payment (Finance Module)  
✗ Customer Management (Customer Bounded Context)  
✗ Travel Operations (Travel Operations Context)  

---

## 4. Search Flow

```
Employee Request
      │
      ▼
Search Validation
      │
      ▼
Provider Selection (Amadeus / Sabre)
      │
      ▼
GDS Adapter Request
      │
      ▼
Live Inventory Retrieval
      │
      ▼
Normalize Provider Response
      │
      ▼
Apply Business Rules & Filters
      │
      ▼
Cache Result (10 Min TTL)
      │
      ▼
Return Results
```

---

## 5. Search Types Supported

- One Way
- Round Trip
- Multi City
- Flexible Dates
- Nearby Airports
- Low Fare Calendar (Future)
- Matrix Search (Future)

---

## 6. Supported Provider Strategy

- **Primary Provider**: Amadeus
- **Secondary Provider**: Sabre
- **Tertiary Provider**: Travelport

*Automatic provider failover occurs if primary provider fails or times out.*

---

## 7. API Inventory

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/flight-search` | Live flight search (One-way, Round-trip, Multi-city) |
| `GET` | `/api/v1/flight-search/:searchId` | Get cached flight search results by search ID |
| `POST` | `/api/v1/flight-search/revalidate` | Revalidate offer price & seat availability |
| `POST` | `/api/v1/flight-search/calendar` | Low fare calendar search across flexible dates |
| `POST` | `/api/v1/flight-search/fare-rules` | Fetch detailed fare rules & cancellation penalties |
| `POST` | `/api/v1/flight-search/baggage` | Detailed baggage allowance breakdown |
| `POST` | `/api/v1/flight-search/seat-map` | Live seat map & availability grid |
| `POST` | `/api/v1/flight-search/airline-pricing` | Airline pricing & fare family breakdown |
| `GET` | `/api/v1/flight-search/providers/status` | GDS provider health & circuit status |

---

## Endpoint Contract: POST /api/v1/flight-search

### 1. Business Purpose
Searches live flight availability from configured GDS providers.

### 2. Endpoint Information
- **Method**: `POST`
- **Path**: `/api/v1/flight-search`
- **Authentication**: Required (Bearer JWT)
- **Authorization**: Required (`flight.search`)
- **Audit Logged**: Optional

### 3. Request Body Example
```json
{
  "tripType": "RoundTrip",
  "origin": "KHI",
  "destination": "JED",
  "departureDate": "2027-01-15",
  "returnDate": "2027-01-28",
  "adults": 2,
  "children": 1,
  "infants": 0,
  "cabin": "Economy",
  "preferredAirlines": ["SV", "EK"],
  "directOnly": false,
  "currency": "PKR"
}
```

### 4. Validation Rules
✓ Origin Airport Exists  
✓ Destination Airport Exists  
✓ Departure Date Valid (Not past date)  
✓ Return Date Valid (After departure date for RoundTrip)  
✓ Passenger Count Valid (Min 1 adult)  
✓ Cabin Valid (`Economy`, `PremiumEconomy`, `Business`, `First`)  
✓ Currency Supported  

### 5. Successful Response (HTTP 200 OK)
```json
{
  "success": true,
  "searchId": "8f2a10b4-3c6d-4e9f-9a1b-7c8d9e0f1a2b",
  "provider": "Amadeus",
  "meta": {
    "totalOffers": 1,
    "currency": "PKR",
    "searchTimestamp": "2026-07-29T01:07:00.000Z",
    "expiresInSeconds": 600
  },
  "results": [
    {
      "offerId": "OFF-SV701-20270115",
      "airline": "Saudi Airlines",
      "airlineCode": "SV",
      "flightNumber": "SV701",
      "origin": "KHI",
      "destination": "JED",
      "departure": "2027-01-15T05:20:00.000Z",
      "arrival": "2027-01-15T09:40:00.000Z",
      "duration": "5h 20m",
      "stops": 0,
      "availableSeats": 9,
      "cabin": "Economy",
      "fareFamily": "Standard Economy",
      "price": 145000,
      "currency": "PKR",
      "baggageAllowance": "2 Pieces (23kg each)",
      "isRefundable": true
    }
  ]
}
```

---

## 8. Caching Strategy

- **Storage**: In-Memory / Redis Cache
- **TTL**: 10 Minutes (600 seconds)
- **Invalidation**: Automatic expiration; live booking always revalidates.

---

## 9. Domain Events

- `FlightSearchRequested`
- `FlightSearchCompleted`
- `FlightSearchCached`
- `ProviderFallbackExecuted`
- `ProviderUnavailable`

---

## 10. AI Coding Rules Summary

✓ Adapter Pattern  
✓ Provider Independent Normalization  
✓ Never Expose Raw Provider DTOs  
✓ Short TTL Cache Strategy  
✓ Retry Failed Providers & Circuit Breaker  
✓ Correlation ID & Audit Logging  

---

## 11. Completion Status

- **Status**: ✅ Production Ready
- **Document ID**: `API-006B`
- **Version**: `1.0.0`
- **Next Document**: `API-006C — Hotel Search APIs`
