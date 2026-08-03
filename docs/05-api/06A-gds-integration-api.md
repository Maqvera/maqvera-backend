---
title: GDS Integration Architecture
document_id: API-006A
version: 1.0.0
status: Production Approved
module: GDS Integration
---

# GDS Integration Architecture

---

## 1. Overview

The GDS Integration module connects the platform with external Global Distribution Systems (GDS) and hotel suppliers.

### Supported Providers
✓ Amadeus  
✓ Sabre  
✓ Travelport (Future)  
✓ Hotelbeds (Future)  
✓ Expedia Partner API (Future)  
✓ Direct Airline APIs (Future)  

*Note: This module never stores airline inventory permanently. It retrieves live availability directly from providers.*

---

## 2. Business Purpose

```
Without GDS:
Employee ──► Search Manually ──► Open Amadeus ──► Search Flights ──► Compare ──► Book ──► Return To ERP

With GDS:
Employee ──► Travel ERP ──► Search Flight ──► GDS Integration ──► Amadeus API ──► Live Results ──► Book
```

Everything happens inside one platform seamlessly.

---

## 3. Responsibilities

### Responsible For:
✓ Flight Search  
✓ Hotel Search  
✓ Fare Search  
✓ Availability Search  
✓ Flight Pricing  
✓ Hotel Pricing  
✓ Flight Booking  
✓ Hotel Booking  
✓ Ticket Issuance  
✓ Booking Cancellation  
✓ Booking Synchronization  
✓ Provider Failover  

### Not Responsible For:
✗ Customer Management (Customer Context)  
✗ Payments & Finance (Finance Context)  
✗ Accounting (Finance Context)  
✗ Travel Execution (Travel Operations Context)  
✗ Attendance (Travel Operations Context)  
✗ Hotel Operations (Travel Operations Context)  

---

## 4. Supported Providers & Strategy

- **Primary Provider**: Amadeus  
- **Secondary Provider**: Sabre  
- **Future Integration**: Travelport, Hotelbeds, Expedia  

*Strategy: Provider selection is configuration-driven with automatic failover.*

---

## 5. High Level Architecture

```
Travel ERP
    │
    ▼
Booking Module
    │
    ▼
GDS Integration Layer
    │
    ▼
Provider Adapter Interface
    │
    ├── Amadeus Adapter
    ├── Sabre Adapter
    └── Travelport Adapter
```

*Rule: Booking Module never talks directly to Amadeus or Sabre APIs. All provider requests flow through the GDS Integration Layer.*

---

## 6. Core Services

- **`FlightSearchService`**: Multi-provider live flight availability and search.
- **`HotelSearchService`**: Live hotel inventory and rates search.
- **`FlightBookingService`**: PNR creation, seat holding, and PNR retrieval.
- **`HotelBookingService`**: Hotel room reservation and booking execution.
- **`TicketService`**: Ticket issuance, voiding, and refund calculation.
- **`PNRService`**: PNR import, sync, and lifecycle management.
- **`FareRulesService`**: Baggage rules, penalty rules, and fare conditions parsing.
- **`PricingService`**: Live price validation, tax breakdown, and currency conversion.
- **`ProviderHealthService`**: Health monitoring, circuit breaking, and latency tracking.
- **`AISearchService`**: AI-driven live ranking and query resolution using GDS data.

---

## 7. Integration Principles

- **Provider Independent**: Unified request/response schema abstracting provider specifics.
- **Adapter Pattern**: Modular provider adapters (`AmadeusAdapter`, `SabreAdapter`).
- **Retry Policies**: Exponential backoff for transient provider glitches.
- **Circuit Breaker**: Automatic provider bypass if failure rates cross thresholds.
- **Caching**: Short-term TTL Redis caching for frequent search queries.
- **Rate Limiting**: Throttling to keep within provider API quotas.
- **Audit Logging**: End-to-end payload logging for compliance and troubleshooting.
- **Idempotency**: Guaranteeing single booking creation on duplicate API retries.

---

## 8. Domain Events

- `FlightSearched`
- `HotelSearched`
- `FlightBooked`
- `HotelBooked`
- `TicketIssued`
- `BookingCancelled`
- `PNRImported`
- `ProviderUnavailable`
- `SearchCached`

---

## 9. AI Integration

The AI Assistant never calls external APIs directly. It interacts through the GDS Integration Layer.

```
User Request
     │
     ▼
AI Assistant
     │
     ▼
AI Search Service
     │
     ▼
GDS Integration Layer
     │
     ▼
Amadeus / Sabre API
     │
     ▼
Live Results ──► AI Ranking ──► Dynamic Recommendation ──► User
```

- AI analyzes live data returned by GDS providers.
- AI never invents or generates fake flight/hotel options.

---

## 10. Completion Status

- **Status**: ✅ Architecture Approved
- **Document ID**: `API-006A`
- **Version**: `1.0.0`
- **Next Document**: `API-006B — Flight Search APIs`
