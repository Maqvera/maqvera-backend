---
title: EXT-027 — AI Agent Memory & Conversation Context
document_id: EXT-027
version: 1.0.0
status: Production Ready
module: AI Integration
---

# EXT-027 — AI Agent Memory & Conversation Context

---

## 1. Audit Finding

`AIConversationModel.js` and `AIAssistantService.chat()` were read in full before writing anything. The real gap was more specific — and more consequential — than "no memory exists":

| § | Claim | Verdict |
|---|---|---|
| — | Raw conversation transcript (`messages`) | Already implemented |
| 9 | Tool Context — execution log per tool call | Partially implemented — `conversation.toolExecutions` records toolName/arguments/succeeded/durationMs, an audit trail, not reusable memory |
| **3–8** | **Structured Search/Selection/Passenger/Booking Context** | **Not implemented at all** |
| **13** | **"Read Memory → Missing Fields? → Ask User / Call Tool → Update Memory"** | **Not implemented** — worse, actively broken: `chat()` built each turn's LLM history from `conversation.messages.filter(m => m.role !== "tool")` — tool RESULTS were dropped from cross-turn context entirely. A follow-up like "only refundable" had nothing structured to reuse; the model either re-asked the user or inferred stale details from its own prior prose |
| 10/11/16 | Context Lifecycle, automatic expiration, manual clear | Not implemented — no timeout, no expiry sweep, no clear endpoint |
| 15 | Memory isolation (tenant/branch/user/session) | Already implemented at the conversation-document level (unchanged, inherited) |
| 11 | Never store passwords/OAuth tokens/payment card data | N/A until this turn — there was no structured memory to violate this in the first place |

A related, pre-existing, **out-of-scope** finding: `getAIConfig().conversationRetentionDays` (`AI_CONVERSATION_RETENTION_DAYS`) is dead config — read nowhere in the codebase, no sweep enforces it. Left alone: it governs whole-conversation retention/archival, a distinct concern from this document's session memory, and fixing it wasn't part of this ask.

---

## 2. What Was Built

### Structured memory — `AIConversationModel.context`

A new subdocument on the existing conversation record (not a parallel collection — reuses the tenant/branch/user/conversation identifiers already there). Every field maps to a real tool parameter or result this codebase actually has:

- **Flight**: origin, destination, departureDate, returnDate, adults, cabin, budget (from `flight_inspiration`'s `maxPrice`), selectedOfferId/selectedProvider (from `propose_flight_booking`), searchedAt.
- **Hotel**: city, checkIn, checkOut, guests, rooms, starRating, selectedHotelId/selectedOfferId, searchedAt.
- **Booking**: `flightApprovalRequestId` / `hotelApprovalRequestId` / `hotelCancellationApprovalRequestId` — the real artifact a `propose_*` tool creates (a pending `AIApprovalRequestModel` row; there is no PNR or payment status at this layer to track, since no tool ever reaches real booking issuance).
- **Passengers**, `pricingToken`, `mealPreference` — present in the schema for forward-compatibility but honestly left null: no tool in `AIToolRegistry.js` currently accepts children/infants/nationality/special-assistance as input, or returns a distinct pricing token, or filters by meal plan. Not fabricated.
- No field for passwords, OAuth tokens, or payment card data exists anywhere in the schema — the enforcement for EXT-027 §11 is the absence of the field, not a runtime filter.

### `services/ai/AIContextMemory.js`

- `applyToolExecution(context, toolName, args, result)` — one small updater per tool this document names (`flight_search`, `flight_inspiration`, `propose_flight_booking`, `hotel_search`, `search_hotel_list`, `get_hotel_room_offers`, `verify_hotel_offer_pricing`, `propose_hotel_booking`, `propose_hotel_cancellation`). Each updater only touches its own namespaced section — this is what makes §12 "Only affected context is refreshed" true by construction, not by a separate invalidation step. A tool this module doesn't track (`get_visa_requirements`, `enterprise_search`, etc.) reports no change and leaves memory untouched.
- `describeForPrompt(context)` — renders only the non-null fields into a compact block; an empty/fresh session adds nothing to the prompt.
- `sessionExpiryDate()` — reads the new `AI_MEMORY_SESSION_TIMEOUT_MINUTES` config (default 60), deliberately separate from the pre-existing `AI_CONVERSATION_RETENTION_DAYS`.

### `AIAssistantService.chat()` — the actual fix

- Loads `conversation.context` at the top of every turn; if it's expired (lazy check, `expiresAt < now`) it starts clean rather than reusing stale data — belt-and-suspenders alongside the scheduled sweep below.
- `SYSTEM_PROMPT_TEMPLATE` now accepts the memory summary and, when non-empty, appends a "KNOWN CONTEXT FROM THIS SESSION" block with an explicit instruction: reuse remembered fields instead of re-asking the user, and only ask for a field genuinely missing from both the current message and memory. This is the doc's §13 workflow, implemented as prompt engineering rather than a new deterministic slot-filling engine — consistent with this codebase's existing fully-LLM-driven tool-calling architecture (no rule-based state machine exists anywhere else in this module either).
- After each **successful** tool call this turn, `AIContextMemory.applyToolExecution` runs and the result is persisted back onto `conversation.context`; a **failed** call never touches memory (verified — see below).
- `expiresAt` refreshes on every turn (any activity resets the idle clock), and `AIContextUpdated` is published only when a tracked tool actually changed something.

### Manual clear + inspection, and automatic expiry

- `AIAssistantService.clearContext()` / `getContext()` — new service methods; `GET` and `POST .../context/clear` under `/api/v1/ai/conversations/:conversationId/context`. Clearing resets `context` only — the message transcript and the conversation document are untouched.
- `services/aiContextExpiryScheduler.js` — new cron sweep (`AI_MEMORY_EXPIRY_CRON_SCHEDULE`, default every 15 minutes), mirroring this codebase's existing scheduler pattern, wired into `server.js`. Finds active conversations whose `context.expiresAt` has passed and clears (never deletes) their memory, publishing `AIContextExpired`.

---

## 3. Verification

24 isolated checks across two scripts, run against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment):

- **`AIContextMemory` unit** (12 checks): namespaced partial updates, passenger-count mirroring, an untracked tool leaving context byte-for-byte unchanged, prompt rendering, and the session-timeout config actually being read from the environment rather than hardcoded.
- **`chat()` end-to-end** (12 checks): a real 5-turn conversation proving — turn 1's `flight_search` call populates structured memory; turn 2's captured LLM system prompt **actually contains** the remembered route/date/passenger count (the concrete proof this is fixed, not just plausible); turn 3's failed tool call does not clobber good memory; a lazily-expired session starts clean on its next turn without waiting for the sweep; and `clearContext`/`getContext` work correctly without touching the transcript.

Full suite held at **49/49** throughout, `node --check` clean on every touched file.

---

## 4. Completion Status

- **Status**: Production Ready
- **Document ID**: `EXT-027`
- **Architecture note honored**: this memory is session-scoped and cleared on expiry/manual clear — it was never mixed with Customer Profile/CRM/Booking Database/Travel History, none of which this change touches.
