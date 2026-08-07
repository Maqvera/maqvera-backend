import mongoose from "mongoose";

/**
 * "Execution Log" — Execution ID, Prompt, Plan, Tools Used, Execution Time,
 * Provider, Cost, Token Usage, Status, Errors, Audit Reference. A plan is
 * created (status "planned") before any tool runs, then transitions to
 * "executing" → "completed"/"failed"/"awaiting_approval"/"rejected".
 */
const AIToolExecutionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    userId: { type: String, required: true, index: true },
    // Snapshot of the requesting user's identity/authorization at plan
    // creation time — EXT-036 §22 "Recovery" needs to reconstruct the
    // execution context (context.userName/role/permissions) to resume a
    // crashed execution without a live HTTP request to read them from. A
    // stale snapshot is an acceptable tradeoff specifically because every
    // write-capable tool (propose_flight_booking, propose_hotel_booking,
    // propose_hotel_cancellation) only ever creates a pending
    // AIApprovalRequestModel row — it never performs the real mutation
    // itself — so a resumed step can, at worst, use since-revoked *read*
    // permissions, never bypass the human-approval gate on a write.
    userName: { type: String, default: "User" },
    role: { type: String, default: "" },
    permissions: [{ type: String }],
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "AIConversation", default: null },
    prompt: { type: String, required: true },
    correlationId: { type: String, required: true, index: true },
    plan: [
      {
        stepNumber: { type: Number, required: true },
        toolName: { type: String, required: true },
        arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
        parallelGroup: { type: Number, default: null },
        requiresApproval: { type: Boolean, default: false },
        reasoning: { type: String, default: null },
        // EXT-036 §23 "Idempotency — Every task includes Execution ID,
        // Idempotency Key, Task ID." Deterministic per (executionId,
        // stepNumber), assigned at plan-creation time — see createPlan().
        idempotencyKey: { type: String, default: null },
        // EXT-028 §8 "Dependency Rules — Tasks execute only after
        // dependencies complete successfully." Planner-declared stepNumbers
        // this step requires; empty/absent means "no declared dependency"
        // (backward compatible with plans created before this field
        // existed — such a step simply runs whenever its parallelGroup's
        // turn comes, same as before). Enforced in executePlan(); see
        // stepDependenciesSatisfied().
        dependsOn: [{ type: Number }],
        // EXT-036 §10 "Conditional Branching." Optional — null means "always
        // run" (backward compatible with every plan created before this
        // field existed). When set, this step only actually runs if the
        // referenced earlier step's real, persisted result has `field`
        // equal to `equals`; otherwise it's recorded state:"skipped" with an
        // honest reason, same as an unmet dependency. `stepNumber` is always
        // folded into this step's own `dependsOn` at plan-creation time
        // (see createPlan) — the engine can't evaluate a condition on a
        // step that hasn't necessarily run yet.
        runIf: {
          stepNumber: { type: Number, default: null },
          field: { type: String, default: null },
          equals: { type: mongoose.Schema.Types.Mixed, default: null }
        }
      }
    ],
    status: {
      type: String,
      // EXT-029 §6 "Timed Out" — a whole-execution wall-clock ceiling
      // (AI_WORKFLOW_MAX_DURATION_MS), distinct from a single step failing.
      // Deliberately no "compensated"/"retrying"/"waiting_event" values:
      // this codebase's compensation is "flag for manual review", never an
      // automatic rollback (see AIOrchestrationService._flagFlightForManualReview's
      // docblock) — a distinct "compensated" status would overstate what
      // actually happened; "retrying" isn't persisted since retries happen
      // synchronously within a step's own attempt loop; and no real
      // external webhook/callback receiver exists anywhere in this
      // codebase (Amadeus here is synchronous REST request/response, not
      // callback-driven), so "waiting_event" has no genuine trigger source
      // to represent — "awaiting_approval" (a real, human-sourced event) is
      // the one wait-state this codebase can honestly claim.
      enum: ["planned", "executing", "completed", "failed", "awaiting_approval", "rejected", "cancelled", "timed_out"],
      default: "planned",
      index: true
    },
    // EXT-036 §5/§21 "Archived." Deliberately NOT a `status` enum value —
    // this execution's real terminal outcome (completed/failed/cancelled/
    // rejected/timed_out) is meaningful and getWorkflowMetrics' status
    // breakdown depends on it staying accurate; archival is orthogonal.
    // `archivedAt` set (via the new archiveExecution()) is the real,
    // honest "put away" signal — never set by the engine itself.
    archivedAt: { type: Date, default: null, index: true },
    // EXT-028 §15 "Cancellation." A running execution is cancelled
    // cooperatively — this flag is checked by the in-flight executePlan()
    // call at its next group boundary (the same point it already
    // checkpoints), not by forcibly aborting an in-progress tool call.
    cancellationRequested: { type: Boolean, default: false },
    cancelReason: { type: String, default: null },
    cancelledBy: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    // EXT-036 §22 "Recovery." Real, honest traceability for how many times
    // (and when) a crash-recovery sweep resumed this execution — distinct
    // from a single step's own `retryCount`. 0/null means this execution
    // has never needed recovery.
    recoveryCount: { type: Number, default: 0 },
    lastRecoveredAt: { type: Date, default: null },
    // EXT-036 §14 "Compensation." Real events, not a status overstating
    // what happened — see AIOrchestrationService._flagFlightForManualReview's
    // own docblock for why this codebase's compensation is "flag for human
    // review," never an automatic rollback.
    compensationEvents: [
      {
        stepNumber: { type: Number, required: true },
        relatedStepNumber: { type: Number, default: null },
        reason: { type: String, required: true },
        approvalRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "AIApprovalRequest", default: null },
        incidentId: { type: mongoose.Schema.Types.ObjectId, ref: "travel_incident_management", default: null },
        flaggedAt: { type: Date, default: Date.now }
      }
    ],
    // EXT-032 §9 "Prompt injection detected before execution." Computed
    // once from the originating `prompt` at plan-creation time (see
    // createPlan) and read back into executePlan's step context, so a plan
    // whose own prompt was flagged can never run a non-read tool — the same
    // defense-in-depth AIAssistantService.chat() already applies to its own
    // conversational turns.
    promptInjectionFlagged: { type: Boolean, default: false },
    toolExecutions: [
      {
        stepNumber: { type: Number },
        toolName: { type: String, required: true },
        arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
        succeeded: { type: Boolean, default: false },
        // EXT-028 §7 "Task States." `succeeded` (existing, kept as the
        // resume/idempotency source of truth — unchanged meaning) only
        // distinguishes true success from everything else; `state` adds
        // the doc's richer breakdown for a step that never got a genuine
        // attempt at all. "pending"/"ready"/"running" have no persisted
        // representation — a step with no toolExecutions entry yet IS
        // that state, implicitly (see AIOrchestrationService.computeProgress).
        // "retry_scheduled" likewise isn't persisted separately: retries in
        // this engine happen synchronously within a step's own attempt
        // loop, never deferred to a later scheduled run.
        state: { type: String, enum: ["completed", "failed", "skipped", "cancelled"], default: "completed" },
        retryCount: { type: Number, default: 0 },
        durationMs: { type: Number, default: 0 },
        startedAt: { type: Date, default: Date.now },
        error: { type: String, default: null },
        idempotencyKey: { type: String, default: null },
        // EXT-036 §10 "Conditional Branching." The tool's real result,
        // masked the exact same way stored `arguments` already are
        // (AIGuardrailService.maskSensitiveData — sensitive-named fields
        // replaced wholesale, numeric/boolean fields like `available`/
        // `found`/`price` pass through untouched) before being persisted.
        // This is what makes a later step's `runIf` evaluable across a
        // crash-recovery resume, not just within one in-memory pass.
        result: { type: mongoose.Schema.Types.Mixed, default: null }
      }
    ],
    provider: { type: String, default: null },
    // EXT-034 "AI Model Management & Multi-LLM Routing" — the specific
    // model AIModelRouterService actually resolved for this execution's
    // most recent LLM call (planning, then overwritten by the synthesis
    // call once it runs) — mirrors `provider`'s exact existing lifecycle.
    model: { type: String, default: null },
    finalAnswer: { type: String, default: null },
    // Set once, the first time status becomes "executing" — never
    // overwritten on a crash-recovery resume, so totalExecutionTimeMs
    // reflects real end-to-end wall-clock time across a restart, not just
    // the resumed attempt's own duration.
    executionStartedAt: { type: Date, default: null },
    tokenUsage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 }
    },
    // Real per-token math against configured rates, always labeled as an
    // estimate — actual provider billing can differ.
    estimatedCostUsd: { type: Number, default: 0 },
    totalExecutionTimeMs: { type: Number, default: 0 },
    // Named `executionErrors`, not `errors` — Mongoose reserves `errors` as
    // a Document-internal validation-error pathname; reusing it produces a
    // runtime warning and risks colliding with Mongoose's own machinery.
    executionErrors: [{ type: String }],
    auditReference: { type: String, default: null }
  },
  { timestamps: true }
);

AIToolExecutionSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
AIToolExecutionSchema.index({ tenantId: 1, status: 1 });

export default mongoose.models.AIToolExecution || mongoose.model("AIToolExecution", AIToolExecutionSchema);
