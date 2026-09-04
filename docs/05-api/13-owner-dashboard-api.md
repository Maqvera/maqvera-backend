# Owner Dashboard API

A single-screen agency-owner overview — "how's my agency doing this month" — distinct from the ops-role-specific dashboards elsewhere in this codebase (`docs/05-api/07-travel-api.md`'s Travel Operations Dashboard, `docs/05-api/06-visa-dashboard-analytics-api.md`, and Finance's dashboards). Those are built for an operations/finance manager working a queue; this one is built for an owner glancing at agency health.

## Endpoint

- `GET /api/v1/dashboard/overview` — returns bookings today/this month, total customers, this month's revenue and profit, pending visa case count, upcoming departures in the next 7 days, the last 10 bookings and last 10 payments, a 12-month bookings/revenue trend, and a this-month package sales breakdown, all in one payload.

Requires JWT authentication, tenant context (`getAccessScope(req)`), and the `dashboard.overview.read` permission (or `admin`). There is no branch-level data isolation (`docs/06-external-integrations/03-final-architecture-no-branches-rbac.md`) — every response is tenant-wide.

## Response shape

```json
{
  "bookingsToday": 3,
  "bookingsThisMonth": 41,
  "totalCustomers": 512,
  "revenueThisMonth": 18250.00,
  "profitThisMonth": 6120.50,
  "pendingVisasCount": 27,
  "upcomingDeparturesThisWeek": 9,
  "recentBookings": [{ "_id": "...", "bookingReference": "BK-...", "customerName": "...", "packageName": "...", "totalAmount": 1200, "currency": "USD", "status": "confirmed", "createdAt": "..." }],
  "recentPayments": [{ "_id": "...", "paymentNumber": "PAY-...", "amount": 500, "currency": "USD", "status": "Captured", "paymentType": "Customer", "transactionDate": "..." }],
  "monthlyBookingsChart": [{ "month": "Sep 2025", "count": 34 }],
  "revenueTrendChart": [{ "month": "Sep 2025", "revenue": 15400.00 }],
  "packageSalesBreakdown": [{ "packageId": "...", "packageName": "...", "bookingCount": 6, "revenue": 7200.00 }],
  "generatedAt": "..."
}
```

`revenueThisMonth` and `profitThisMonth` are read through `services/FinancialReportService.js`'s `getPeriodMovement` + `groupRowsForProfitAndLoss` — the same real Chart-of-Accounts/General-Ledger period-movement aggregation every P&L report and Finance dashboard in this codebase uses (see `docs/05-api/07-finance-api.md`), never a separate Payment/Expense re-derivation. A tenant with no Chart of Accounts or journal postings yet honestly reports `0` for both, the same "no data yet" convention `FinancialReportService.getAccountCodeMovement` documents. `monthlyBookingsChart`/`revenueTrendChart` cover the trailing 12 calendar months including the current one, oldest first. `pendingVisasCount` excludes `VisaCaseModel` cases in a terminal status (`completed`, `rejected`, `cancelled`, `expired`, `withdrawn`, `blacklisted` — see `utils/visaConstants.js`).

This endpoint aggregates transactional collections directly (`BookingHeaderModel`, `CustomerModel`, `VisaCaseModel`, `PaymentModel`) rather than reading a pre-materialized summary — unlike the Visa/Finance dashboards, there is no `OwnerDashboardSummaryModel` read model yet. Acceptable for a single owner-facing glance endpoint that isn't a hot path; revisit if usage patterns change.
