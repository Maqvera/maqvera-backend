# Visa API — Part 12: Dashboard & Analytics

Visa dashboards are read-only consumers of `visa_analytics_summary`; they never query Visa transactional records in request handling. `VisaAnalyticsEngine` refreshes the summary asynchronously from Visa domain events and maintains a short-lived cache for dashboard reads. Officer metrics are materialized in the Visa summary and customer-specific metrics are materialized in `visa_customer_analytics_summary`.

When a summary has not yet been generated, an API returns an explicitly marked `pendingRefresh` response and schedules a background refresh. It never performs a synchronous transactional aggregation for the request.

## Endpoints

- `GET /api/v1/dashboard/executive` returns executive KPIs, approval rate, top embassies, alerts, and generation time.
- `GET /api/v1/dashboard/operations` returns the current queue, document and embassy backlog, today’s work, passport inventory, and incidents.
- `GET /api/v1/dashboard/officer` returns an officer-oriented operations view.

All endpoints require JWT authentication and tenant context. `branchId` defaults to the authenticated branch; `branchId=all` requires a management role. A newly onboarded tenant may receive `pendingRefresh: true` until the first event-driven summary refresh completes.
