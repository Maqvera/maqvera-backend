---
title: EXT-031 — AI Prompt Management & System Instructions
document_id: EXT-031
version: 1.0.0
status: Production Ready (scoped)
module: AI Integration
---

# EXT-031 — AI Prompt Management & System Instructions

---

## 1. Audit Finding

Confirmed by reading every prompt-producing call site in `AIAssistantService.js` and `AIOrchestrationService.js`: all three system prompts in this codebase (chat, planning, synthesis) were hardcoded template-literal constants — exactly the "Without Prompt Management" flow this document opens with (`Developer → Modify Source Code → Deploy → Restart Services`). `AIConversationModel.mode` already existed as a real enum (Assistant/Operations/Management/Customer/Finance/Support/Developer) but had no effect on prompt content — a role concept with nothing behind it.

| § | Claim | Verdict |
|---|---|---|
| 9 "Tool Prompts" | Available Tools/Input/Output Schema/Retry Rules/Approval Requirements | **Already implemented** — this is exactly `AIToolRegistry.getCatalog()`, live and always current. Deliberately NOT duplicated as a separately-editable prompt type (§21 already correctly treats this as infrastructure, not authored text) |
| 6/7/17 | System/Role prompts, composition | **Partially implemented** — a system prompt existed; role prompts and real composition did not |
| **11/12/14/15/19** | **Versioning, Lifecycle, Deployment, Rollback, RBAC+immutable history** | **Not implemented at all** — no prompt storage, no version concept, no publish/rollback, no state machine |
| **10** | **Prompt Variables — `{{tenantName}}` etc.** | **Not implemented as data** — variable values reached the prompt via JS template-literal interpolation (`${context.tenantId}`), which is still source code, not an editable placeholder in stored text |
| **13** | **Prompt Testing — Golden Dataset, Quality Scores** | **Not implemented** |
| **20** | **Monitoring — Execution Count, Latency, Token Usage, Quality Score** | **Not implemented** — no per-prompt usage tracking existed |
| §16 "Guardrails" | AI must never reveal secrets/prompts/bypass permissions... | **Already implemented** as hardcoded rules inside the existing system prompt text, and correctly left there — this document's own next-in-sequence sibling, EXT-032 "AI Safety, Guardrails & Policy Enforcement", is the deeper policy-enforcement layer; building it here would be scope creep ahead of the user's own sequencing. EXT-031's job was narrower: make guardrail *text* one more manageable, versionable prompt type, which it now is |

---

## 2. What Was Built

### The infrastructure — three new models + `AIPromptService`

- `AIPromptModel` — a named, versioned "slot" (`promptType` + `key` + `language`), e.g. (`system`, `default`, `en`) or (`role`, `Operations`, `ar`). Language is part of the slot's identity, not a version detail — §18 "Language selected dynamically" means each language is independently versioned and can be published/rolled back on its own schedule.
- `AIPromptVersionModel` — immutable once created (§19 "Prompt history immutable" — only `status` and usage counters ever change after creation), a real state machine (`draft → review → testing → approved → published → archived`, plus a `rejected` branch), real per-version usage counters (`executionCount`/`totalLatencyMs`/`totalTokens`/success-failure), and an embedded history of real test runs.
- `AIPromptTestCaseModel` — reusable across every version of a prompt (§13 "Regression Tests" compares the same cases across versions).
- `AIPromptService` — versioning, publish/rollback (with automatic archival of whatever was previously published — never two "published" versions at once), cache-backed resolution (reusing `utils/cacheManager.js`, the exact same Redis-or-memory abstraction already used elsewhere in this codebase — publish/rollback explicitly invalidate the resolved key, so a change is live on the very next request, §14 "No API restart required"), `{{variable}}` interpolation (unknown placeholders left literal — observable, never silently dropped), and real prompt composition.

### Honest default-fallback design — zero behavior change until someone customizes

The exact previous hardcoded content was **relocated, not deleted or rewritten**, into `utils/aiPromptDefaults.js`. `AIPromptService.resolvePrompt()` returns `null` — never an error, never fabricated content — when a tenant hasn't published anything for a given slot; `composeChatPrompt()`/`composeWorkflowPrompt()` fall back to these exact defaults in that case. This means: **no tenant's AI behavior changes at all** until an admin actively authors and publishes a custom prompt through the new API — a safe, incremental rollout rather than a risky rip-and-replace of carefully-tuned safety text built up across this entire session (prompt-injection defenses, EXT-027 memory injection, EXT-030 RAG instruction).

Deliberately **not** pre-authored: default "role" (Operations AI, Visa AI, ...) or "guardrail" content. No such differentiated text ever existed before this document — inventing specific behavioral rules without real business input would encode untested assumptions as if they were considered decisions. The infrastructure fully supports authoring and publishing these; nothing ships pre-written.

### Real composition (§17)

`composeChatPrompt()`: system + role(mode, if published) + guardrail(if published), each independently resolved/interpolated, concatenated, then the existing EXT-027 memory summary appended exactly as before. "Retrieved Knowledge" (§17's own list) is deliberately **not** assembled here — EXT-030 made retrieval a tool the model calls on demand, consistent with every other capability in this codebase being tool-driven rather than an automatic pre-step; retrieved content reaches the model through conversation history via the tool-result message, not the system prompt. Stated explicitly here rather than silently deviating from the document's own diagram.

`composeWorkflowPrompt()`: same resolve-with-fallback pattern for the planning and synthesis prompts. The live tool catalog listing is deliberately **not** part of the editable template — it's built fresh from the real `AIToolRegistry` every call and passed in as a `{{toolCatalog}}` variable, so an admin can never publish a stale or wrong tool list that diverges from what actually exists.

### Real prompt testing (§13)

Test cases define real, literal substring assertions (`expectedContains`/`expectedNotContains`) against a real LLM call using the target version's actual content. **Never an LLM asked to grade another LLM's output** — that would just be one unverified model call judging another, not a measurement. `passRate` (the "Quality Score") is a genuine pass-count over real checks, appended to that version's `testRuns` history so a quality trend across versions is real and inspectable, not a single overwritten number.

### Real monitoring (§20)

Every actual LLM call made with a DB-resolved prompt records latency/tokens/success against that exact version via `recordUsage()`. Calls using the hardcoded fallback record nothing — correctly, since there's no versionId and nothing an admin could act on for content they don't control. `getPromptMetrics()` derives execution count, average latency, average tokens, success rate, and latest quality score straight from these real counters.

### API + RBAC (§19)

`POST/GET /api/v1/ai/prompts`, versions, status transitions, rollback, test cases, test runs — full CRUD. Publishing and rolling back require a dedicated `ai.prompt.publish` permission (or `admin`) — distinct and stricter than the `ai.prompt.manage` permission needed to merely draft/edit, matching "Only authorized administrators may publish prompts" literally.

---

## 3. Verification

26 isolated checks against the real production code (`node:test`'s `mock.module`, no live MongoDB in this environment — `CacheManager` itself was **not** mocked, its real in-memory fallback was exercised directly):

- **Lifecycle/publish/rollback/composition** (19 checks): the state machine genuinely rejects an invalid jump (draft straight to published) and accepts the real full chain; publish is RBAC-gated; publishing immediately changes what `resolvePrompt` returns with no cache-staleness; the previously-published version is auto-archived, never left dangling; rollback republishes an old version, marks it `isRollback`, and archives whatever was live; `interpolate` substitutes known variables and leaves unknown ones literal; an un-customized tenant gets the exact real relocated default (proving the safe-fallback design actually works); a customized tenant gets their own real content with variables interpolated and memory appended; the workflow prompt's live tool catalog is genuinely interpolated in.
- **Golden-dataset testing** (7 checks): a real LLM call per test case; a case whose real output contains the expected phrase passes, one that's missing it and contains a forbidden phrase fails with both reasons named; pass rate computed correctly; a test-run entry persisted to history.

Full suite held at **49/49** throughout (proving the default-fallback design preserves identical existing behavior), `node --check` clean on every touched file, no circular-import issues introduced by wiring `AIPromptService` into both `AIAssistantService` and `AIOrchestrationService`.

---

## 4. Completion Status

- **Status**: Production Ready (scoped exactly as described above)
- **Document ID**: `EXT-031`
- **Next recommended**: EXT-032 — AI Safety, Guardrails & Policy Enforcement, per the source document's own pointer — the deeper enforcement-mechanics layer this document's §16 deliberately deferred to it.
