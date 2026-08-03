# Visa Enterprise Architecture — Implemented Blueprint

## Runtime topology

The current application is a Node.js/Express modular monolith with MongoDB/Mongoose as its operational database. It is multi-tenant and multi-branch at the model/query boundary. The process starts only after MongoDB connects, then initializes cache, analytics, search, timeline, and orchestration listeners.

| Context | Write ownership | Read model / integration |
| --- | --- | --- |
| Visa case, requirements, documents, workflow | Visa services and aggregate models | Timeline events, dashboard summaries, search index |
| Embassy, appointment, passport, incident | Dedicated domain services | Timeline, analytics, search event consumers |
| Analytics | `KPIEngine` worker | Summary collections + Redis/memory cache |
| Search | `SearchEngineService` indexer | `search_index`, saved-search and history collections |
| Files | Document service | Configured local, S3-compatible, or Cloudinary provider |

## Event contract

`publishEvent(type, payload)` enriches each event with `eventId` and `occurredAt`, dispatches listeners asynchronously, and records it in `domain_event` when `EVENT_OUTBOX_ENABLED=true` and MongoDB is connected. This creates durable event traceability; `EVENT_BUS_TRANSPORT=memory` is appropriate for one process only. Horizontal deployment requires a broker adapter (for example Redis Streams, RabbitMQ, or Kafka) configured by infrastructure before scaling event consumers.

## Configuration and integrations

All credentials remain in environment variables. `envValidator` validates JWT/MFA secrets and storage-provider credentials. Object storage uses `FILE_STORAGE_BACKEND`; Redis uses `REDIS_URL`; courier and GDS providers use their own base URLs/API credentials. No provider URL or credential is synthesized in application code.

## Operational rules

- Controllers authenticate and pass tenant/branch context to services.
- Commands write their owned aggregate and publish domain events.
- Dashboards and search read summary/index collections, not operational Visa records.
- Cross-context updates occur through APIs/events, not direct collection writes.
- AI/verification results remain advisory; human workflow transitions make final decisions.
