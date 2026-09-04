import crypto from "crypto";
import CacheManager from "../utils/cacheManager.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import OpenAIAdapter from "./ai/OpenAIAdapter.js";
import { resolveExtractionSchema } from "../utils/voiceBookingExtractionRegistry.js";
import { buildFieldPatchTool, buildFieldPatchSystemPrompt } from "../utils/fieldPatchSchema.js";

const openAIAdapter = new OpenAIAdapter();

const SESSION_KEY_PREFIX = "voice-booking-session:";
// How long an idle session survives with no new chunk before it's treated
// as abandoned — renewed on every chunk, so an active dictation session
// never expires mid-use. Env-driven, not a magic number.
const SESSION_TTL_SECONDS = parseInt(process.env.VOICE_BOOKING_SESSION_TTL_SECONDS, 10) || 600;

const sessionKey = (sessionId) => `${SESSION_KEY_PREFIX}${sessionId}`;

/**
 * Voice-Based Booking Creation PRD B4.3 — Mode B (Live Voice Booking
 * Creation) session state + the PATCH-application loop (B4.2). Deliberately
 * built on CacheManager (utils/cacheManager.js), not a raw in-process Map —
 * this repo has no Dockerfile/docker-compose/PM2/k8s config anywhere
 * (checked before writing this), so single- vs multi-instance deployment
 * can't be confirmed either way; CacheManager already solves exactly this
 * class of problem (transparently Redis-backed when REDIS_URL is set, an
 * in-memory Map fallback otherwise) — reusing it means a session survives
 * correctly under either deployment shape without this service having to
 * guess, and the CLAUDE.md-documented rule ("never call Redis directly —
 * go through CacheManager") is followed for free. TTL-based expiry also
 * satisfies "orphaned session automatically cleaned up" (Acceptance
 * Criteria #7) with no separate sweep job needed.
 */
class BookingVoiceSessionService {
  /** Throws (bookingType) if unsupported, before any session is created. Returns the new sessionId. */
  static async startSession({ tenantId, bookingType }) {
    resolveExtractionSchema(bookingType);
    const sessionId = crypto.randomUUID();
    const session = { tenantId, bookingType, draftState: {}, runningTranscript: "" };
    await CacheManager.set(sessionKey(sessionId), session, SESSION_TTL_SECONDS);
    return sessionId;
  }

  /**
   * Called per audio chunk. Returns { updatedDraftState, transcriptDelta }.
   * Throws a clear, catchable error if the session doesn't exist or has
   * expired — never a silent no-op (Acceptance Criteria #7's own
   * "session-not-found" case).
   *
   * B4.2's correction-handling crux: every call sends the AI BOTH the
   * current draft state AND the full running transcript so far (not just
   * this chunk) — "no wait, 21 August" is only interpretable as a
   * correction to a specific field when the model can see that field was
   * already set to "20 August" moments earlier in the same transcript.
   * Simplifying this to "re-extract from just the new chunk" would
   * silently break exactly the scenario this feature exists for.
   */
  static async processChunk(sessionId, audioChunkBuffer, mimeType) {
    const session = await CacheManager.get(sessionKey(sessionId));
    if (!session) throw new Error("Voice session not found or expired.");

    const { text: chunkText } = await openAIAdapter.transcribeAudio({ audioBuffer: audioChunkBuffer, mimeType });
    if (!chunkText?.trim()) {
      await CacheManager.set(sessionKey(sessionId), session, SESSION_TTL_SECONDS);
      return { updatedDraftState: session.draftState, transcriptDelta: "" };
    }

    session.runningTranscript = `${session.runningTranscript} ${chunkText}`.trim();

    const { fieldNames, typeLabel } = resolveExtractionSchema(session.bookingType);
    const tool = buildFieldPatchTool(fieldNames);
    const systemPrompt = buildFieldPatchSystemPrompt(typeLabel, fieldNames);

    const { toolCalls } = await AIModelRouterService.route({
      tenantId: session.tenantId,
      category: "reasoning",
      messages: [{
        role: "user",
        content: `Current draft state: ${JSON.stringify(session.draftState)}\n\nFull transcript so far: ${session.runningTranscript}`
      }],
      tools: [tool],
      systemPrompt
    });

    const call = (toolCalls || []).find((c) => c.name === "apply_field_patch");
    const operations = call?.arguments?.operations || [];
    for (const op of operations) {
      // Defense: never apply a patch to a field name the AI wasn't given —
      // the tool's own enum should already prevent this, but a
      // provider/model that doesn't strictly enforce JSON-schema enums is
      // a real, seen-before failure mode elsewhere in this codebase's AI
      // call sites, not a hypothetical one.
      if (!fieldNames.includes(op.field)) continue;
      if (op.op === "clear") delete session.draftState[op.field];
      else session.draftState[op.field] = op.value;
    }

    await CacheManager.set(sessionKey(sessionId), session, SESSION_TTL_SECONDS);
    return { updatedDraftState: session.draftState, transcriptDelta: chunkText };
  }

  /**
   * Ends the session and removes it from the store. Returns the final
   * field set in EXACTLY the same shape/typing Mode A's
   * BookingVoiceParserService produces (PRD B1: "Final draft state == same
   * shape as Mode A's response") — reuses the same per-type `mapFields`/
   * `validate` from the registry rather than a second conversion, since
   * `draftState`'s accumulated {fieldName: rawValue} shape is exactly what
   * `mapFields` already expects (it's the same raw tool-argument shape
   * Mode A's AI tool call returns). Returns null if the session was
   * already gone (expired/already ended) — never throws.
   */
  static async endSession(sessionId) {
    const session = await CacheManager.get(sessionKey(sessionId));
    await CacheManager.invalidate(sessionKey(sessionId));
    if (!session) return null;

    const { mapFields, validate } = resolveExtractionSchema(session.bookingType);
    const fields = mapFields(session.draftState);
    return { fields, transcript: session.runningTranscript, warnings: validate(fields) };
  }
}

export default BookingVoiceSessionService;
