# Visa API — Part 11: Notes & Timeline

The Visa Timeline is the immutable, tenant- and branch-isolated operational history for a case. Business modules publish domain events to the central Timeline Event Bus; the bus stores a canonical event, indexes it for search, and makes it available to the AI context provider.

## Endpoints

- `GET /api/v1/visa-cases/{visaCaseId}/timeline` returns newest-first paginated history. Supported filters: `page`, `pageSize`, `eventType`, `performedBy`, `dateFrom`, `dateTo`, `module`, `visibility`, and `search`.
- `POST /api/v1/visa-cases/{visaCaseId}/notes` creates a manual note and a corresponding immutable event. `text` is required and limited to 5,000 characters. `noteType`, `visibility`, `mentions`, and attachment metadata are supported.
- `GET /api/v1/timeline/{eventId}` returns an event with comments, attachments, metadata, and audit-relevant context.
- `GET /api/v1/visa-cases/{visaCaseId}/ai-context` returns read-only chronological context for AI use.

## Rules

Timeline records are append-only. Archiving changes discoverability only; it never edits or deletes the original event. All automatic Visa events are normalized by `VisaTimelineEventBus`, including case, workflow, documents, verification, embassy, appointment, passport, and incident activities. Timeline events are also placed in the enterprise full-text search index.
