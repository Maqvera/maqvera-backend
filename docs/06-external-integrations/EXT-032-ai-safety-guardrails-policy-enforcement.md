---
title: EXT-032 — AI Safety, Guardrails & Policy Enforcement
document_id: EXT-032
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-032 — AI Safety, Guardrails & Policy Enforcement

---

## 1. Audit Finding

Read every enforcement point across `AIToolRegistry.js`, `AIAssistantService.js`, `AIOrchestrationService.js`, `AIApprovalRequestModel.js`, and `utils/aiConfig.js` before writing any code.

| § | Claim | Verdict |
|---|---|---|
| 6 "AI Permission Model" | Search/Explain/Recommend allowed; Book/Cancel/Refund/Payment/Permission-change forbidden | **Already implemented** — `AIToolRegistry`'s catalog literally has no tool that cancels, refunds, modifies a payment, or changes a permission; every write-capable tool is a `propose_*` action that only ever creates a pending `AIApprovalRequestModel` row |
| 7 "Human Approval Policy" | Flight/hotel booking & cancellation require approval; AI cannot bypass | **Already implemented** — `propose_flight_booking`/`propose_hotel_booking`/`propose_hotel_cancellation` + `decideApproval()`, real and enforced since earlier EXT documents |
| 10 "Tool Restrictions" | Allowed Roles/Inputs/Outputs/Approval/Rate Limit/Max Execution Time, every tool | **Partially implemented** — everything except execution-time enforcement existed; the timeout was only ever wired into `AIOrchestrationService.runStep`'s own wrap, meaning a tool called directly from the conversational `AIAssistantService.chat()` path had **no timeout at all** |
| 17 "Rate Limiting" | Per-user/tenant/global limits per tool | **Already implemented** — `AIToolRateLimiter` |
| **4 "Guardrail Architecture"** | **Policy Engine → Risk Analyzer → ... → Response Validator, as named stages** | **Not implemented as a unifying engine** — the individual real pieces existed scattered across two services with no single choke point and no tenant-configurable policy layer |
| **5 "Policy Categories"** | **Security/Business/Travel/Finance/Privacy/Compliance/AI/Custom, configurable** | **Not implemented at all** — no policy storage, no policy model |
| **8 "Sensitive Data Protection"** | **Passport/National ID/Credit Card/Bank Account/... masked automatically** | **Not implemented** — a real, concrete gap: `propose_flight_booking`'s raw `passportNumber` argument was being persisted verbatim into `conversation.messages`/`toolExecutions`, which also feeds back into the LLM's own context on the next turn |
| **9 "Prompt Injection Protection — detected before execution"** | Injection detection blocks the action | **Partially implemented** — `AIAssistantService.detectPromptInjection()` existed and correctly flagged the conversation, but the flag was **audit-only**; a flagged turn could still trigger `propose_flight_booking` etc. with zero additional friction. `AIOrchestrationService.createPlan()` had no injection check on its own prompt at all |
| **11 "Response Validation"** | Sensitive Data/Permission Leakage/Hallucination Risk/Policy Compliance | **Partially implemented** — only a literal system-prompt-leak string check existed; no sensitive-data masking on outbound answers, no groundedness signal |
| 12 "Hallucination Prevention — never invent bookings/prices/PNRs" | Architectural guarantee | **Already implemented** structurally (every recommendation/citation is sourced from real tool results, never parsed from free text) — kept exactly as-is; only a new advisory groundedness *check* was added on top (§11 above) |
| **14 "Risk Levels"** | **Low/Medium/High/Critical, computed, drives approval/logging/escalation** | **Not implemented** — `tool.riskLevel` was a static per-tool label (`"read"`/`"high"`), never a computed, request-specific score |
| **18/19/20 "Incident Response / Monitoring / Audit"** | Structured, immutable, queryable security decisions with Policy ID/Risk Score/Correlation ID | **Not implemented** — generic `AuditLogModel` rows existed for chat/execute/approval events, but nothing recorded a guardrail *decision* with risk score, matched policy, or injection status; no incident was ever raised for a blocked manipulation attempt |

---

## 2. What Was Built

### The Policy Engine — `services/ai/AIGuardrailService.js`

A new service, deliberately **not** importing `AIToolRegistry` (and not imported by anything that would create a cycle back to it) — the caller passes in `toolRiskLevel` rather than this service looking the tool up itself, keeping the module graph one-directional (`AIToolRegistry → AIGuardrailService`).

- **`detectPromptInjection(text)`** — the same bounded regex-phrase heuristic that existed in `AIAssistantService`, relocated here as the single source of truth. `AIAssistantService.detectPromptInjection()` and `AIOrchestrationService.createPlan()` both now delegate to it, so a flagged conversational turn and a flagged formal-plan prompt are detected identically.
- **`scanSensitiveFields` / `maskSensitiveData` / `maskValue`** (§8) — field-**name**-based detection (passport, national ID, CNIC, SSN, credit card, bank account/IBAN, medical info, visa documents, personal notes, auth tokens/secrets) is the reliable signal for structured tool arguments; free-text **value**-shape regexes (credit-card/CNIC/IBAN-shaped) are a secondary, best-effort scan for content with no key name to go by — both stated explicitly as bounded heuristics, the same honesty standard already applied to the existing injection detector.
- **`assessRisk({toolRiskLevel, promptInjectionFlagged, sensitiveFieldsFound})`** (§14) — a real, transparent, additive score (base score per tool's static `read`/`medium`/`high`/`critical` classification, `+30` for an injection flag, `+15` per sensitive field), classified into low/medium/high/critical against configurable thresholds. Same honesty precedent as the existing `confidenceScore` in `AIAssistantService` — a real computed signal, not a fabricated certainty number.
- **`evaluate(...)`** (§4/§5/§9) — the actual Policy Engine decision point:
  1. **Defense-in-depth injection block** — a turn flagged for injection can never trigger a non-read tool, checked in-memory first, independent of DB availability or tenant policy configuration.
  2. **Tenant policy evaluation** (§5) — real, DB-backed `AIPolicyModel` rows, three genuinely enforceable rule types: `block_tool` (disable a tool tenant-wide or per-tool), `restrict_role` (an additional, admin-configurable role gate on top of the existing static `requiredRoles`), `max_risk_level` (deny anything whose *computed* risk meets a threshold). A fourth type, `require_approval`, was deliberately **not** built — every non-read tool in the catalog already requires approval, so a policy promising to dynamically wrap an arbitrary tool in an approval flow it doesn't support would be a policy that looks configurable but does nothing real.
  3. **Immutable audit** (§20) — every non-read-tool decision writes one `AIGuardrailAuditModel` row (tenantId/branchId/userId/correlationId/toolName/decision/riskLevel/riskScore/riskReasons/policyId/reason/promptInjectionFlagged/sensitiveFieldsDetected). Rows are only ever created, never updated — same discipline as the existing `AuditLogModel`.
  4. **Incident creation** (§18) — scoped deliberately narrow: only a *blocked* decision caused by a real injection flag raises a real `EnterpriseIncidentEngineService` incident (category `Security`, severity `High`). Routine policy/permission denials do **not** raise incidents — that would just be log spam for ordinary admin configuration, not a security event.
- **`validateResponse({finalAnswer, toolResultsText})`** (§11/§12) — the leaked-system-prompt check relocated here unchanged; a new sensitive-value mask pass over the final answer text; a new, deliberately **advisory-only** groundedness check — any currency-amount-shaped token (`PKR 45000`, `$120`, ...) in the answer that doesn't appear verbatim in this turn's actual tool-result text is surfaced as `possiblyUngroundedClaims`, never silently rewritten or blocked (a false positive here must never corrupt a correct answer).
- **Policy CRUD + monitoring** — `createPolicy`/`listPolicies`/`updatePolicy`/`deletePolicy`, `listAuditEntries`, `getGuardrailMetrics` (§19: total decisions, blocked requests, injection attempts, policy violations, risk-level breakdown — real DB aggregation, mirrors `AIOrchestrationService.getWorkflowMetrics`'s own facet pattern).

### Wired into the single real choke point — `AIToolRegistry.execute()`

Both entry paths (`AIAssistantService.chat()`'s direct tool calls and `AIOrchestrationService.runStep()`'s plan-driven calls) already funnel through this one method, so it's the one place guardrail enforcement needed to land:

- **Execution timeout** (§10) — every `tool.handler` call is now wrapped in the same `withTimeout` pattern `AIOrchestrationService` already used, closing the real gap: a tool invoked from a live chat turn previously had **no** execution-time ceiling at all. The orchestration engine's own existing outer wrap becomes a harmless redundant race against the identical duration, not a behavior change (verified: the pre-existing EXT-029 timeout tests are untouched and still pass).
- **Policy Engine gate**, scoped to non-read tools only — `tool.riskLevel !== "read"` triggers `AIGuardrailService.evaluate()` after the existing permission check and before the rate limiter. Ordinary search/explain/recommend calls (§6's own "AI may" list) never pay for the guardrail's policy-DB lookup; they have nothing meaningful to be evaluated against.

### Prompt-injection propagation into both entry paths (§9)

- `AIAssistantService.chat()` — the existing `flaggedInjection` (now computed via `AIGuardrailService.detectPromptInjection`) is threaded into the tool-call `context` as `promptInjectionFlagged`, so a manipulated conversational turn can never slip a `propose_*` call through.
- `AIOrchestrationService.createPlan()` — the raw planning prompt is now checked the same way, and the result is **persisted** on the new `AIToolExecutionModel.promptInjectionFlagged` field (a plan and its execution are two separate API calls, so the flag has to survive between them). `executePlan()` reads it back into the step context, so a formal plan whose own originating prompt was flagged gets exactly the same defense-in-depth as a live chat turn.

### Sensitive-data masking at the two real persistence points (§8)

Both services now call `AIGuardrailService.maskSensitiveData()` **only** on the copy that gets stored/redisplayed — never on the data actually handed to a tool handler:

- `AIAssistantService.chat()` masks `toolArguments`/`arguments` before pushing into `conversation.messages`/`toolExecutionsThisTurn` (this is what also re-enters the LLM's own context on the next turn — the real leak surface).
- `AIOrchestrationService.executePlan()` masks the same fields at all three `toolExecutions.push(...)` sites (normal completion, dependency-skip, cancellation/timeout halt).
- **Deliberately left unmasked**: `execution.plan[].arguments` and the real `AIApprovalRequestModel.arguments`/`proposedAction.body`. Both are the actual operative data a human approver needs to complete a real booking (e.g. the real passport number) — masking them would silently corrupt the one legitimate downstream use of that data, the same reasoning already established for why `AIApprovalRequestModel` itself stores real values.

### API + RBAC — `controllers/AIGuardrailController.js` / `routes/AIGuardrailRoutes.js`

Mounted at `/api/v1/ai/guardrails`. Policy CRUD (`ai.guardrail.manage` permission, or admin) at `/policies`; `GET /audit` and `GET /metrics` are **admin-only** (not just `ai.guardrail.manage`) since a guardrail-audit row can reveal exactly what another user attempted or was blocked from — the same stricter gate already used for `GetWorkflowMetrics`.

---

## 3. Verification

41 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment):

- **`verify_guardrail_service.mjs`** (25 checks): injection detection true/false positives; sensitive field-name scanning and deep masking; free-text value masking; risk scoring across read/high/injection/sensitive-field combinations; `evaluate()`'s defense-in-depth injection block (with a real audit row **and** a real security incident created); a read tool is never blocked by the injection flag; all three real policy rule types (`block_tool`, `restrict_role` including the admin-bypass case, `max_risk_level`) genuinely block/allow as configured; `validateResponse`'s leak-sanitization, sensitive-value masking, and groundedness check (both the "present in tool results → not flagged" and "absent → flagged" cases); policy-creation validation rejects bad input.
- **`verify_tool_registry_guardrail.mjs`** (6 checks): a read tool never invokes the guardrail's DB-backed `evaluate()`; a non-read tool does, and a blocked decision genuinely prevents the handler from running (no approval request created); the real unmasked arguments reach `evaluate()` for sensitive-field scanning.
- **`verify_orchestration_guardrail.mjs`** (6 checks): a real injection phrase in a planning prompt sets and persists `promptInjectionFlagged`; `executePlan()` reads it back and the guardrail genuinely blocks the plan's own step; the stored `toolExecutions.arguments` is masked while `execution.plan[].arguments` (the real operative data) is deliberately left intact.
- **`verify_chat_guardrail.mjs`** (10 checks): the conversational path mirrors the same guarantees end-to-end — injection flag reaches the tool context, real arguments reach the tool call, masked arguments are what's persisted, a leaked system prompt is sanitized in the final answer, and an ordinary message is completely unaffected.

Full suite held at **49/49** throughout, `node --check` clean on every touched/new file. No circular-import issues from wiring `AIGuardrailService` into `AIToolRegistry`, `AIAssistantService`, and `AIOrchestrationService` (verified by deliberately keeping the dependency one-directional — `AIGuardrailService` never imports `AIToolRegistry`).

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-032`
- **Next recommended**: EXT-033 — AI Observability, Monitoring & Evaluation, per the source document's own pointer — the DevOps-layer counterpart (prompt quality, tracing, latency/token dashboards, model comparison) to this document's security-layer focus.
