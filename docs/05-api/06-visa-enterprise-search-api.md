# Visa API — Part 13: Enterprise Search

`/api/v1/search` is a read-only API backed by the `search_index` read model. It never falls back to Visa, document, passport, appointment, incident, or customer operational collections during a request.

The index is asynchronously updated from domain events for Visa cases, travelers, documents, embassy submissions, appointments, passports, incidents, and timeline events. Every document is tenant scoped; permission requirements are checked against the authenticated token before results are returned.

## Endpoints

- `GET /api/v1/search?q=&entityType=&country=&embassy=&visaType=&status=&officer=&nationality=&priority=&severity=&dateFrom=&dateTo=&page=&pageSize=&sort=&order=`
- `GET /api/v1/search/visa-cases`
- `GET /api/v1/search/travelers`
- `GET /api/v1/search/passports`
- `GET /api/v1/search/documents`
- `GET /api/v1/search/incidents`
- `GET /api/v1/search/appointments`
- `GET /api/v1/search/embassies`
- `GET /api/v1/search/suggestions`
- `POST /api/v1/search/saved`
- `GET /api/v1/search/saved`
- `DELETE /api/v1/search/saved/{savedSearchId}`

`pageSize` is limited by `ENTERPRISE_SEARCH_MAX_PAGE_SIZE`. Saved and recent searches are stored in `saved_search` and `search_history`, not process memory.
