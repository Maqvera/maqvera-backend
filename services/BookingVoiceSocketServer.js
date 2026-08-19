import { WebSocketServer } from "ws";
import { resolveAuthFromAccessToken, AccessTokenError } from "../middleware/authenticateAccessToken.js";
import TenantSubscriptionService from "./TenantSubscriptionService.js";
import BookingVoiceSessionService from "./BookingVoiceSessionService.js";
import { SUPPORTED_VOICE_BOOKING_TYPES } from "../utils/voiceBookingExtractionRegistry.js";

const VOICE_BOOKING_WS_PATH = process.env.VOICE_BOOKING_WS_PATH || "/ws/voice-booking";

const send = (ws, type, payload = {}) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
};

// Same permission set ParseVoiceBooking/ParseSupplierDocument already
// require — this is still a booking-creation action, just over a
// different transport.
const hasVoiceBookingPermission = (permissions = []) =>
  permissions.includes("bookings.create") || permissions.includes("booking.create") ||
  permissions.includes("bookings.update") || permissions.includes("booking.update");

/**
 * Voice-Based Booking Creation PRD B4.4/B4.5 — Mode B (Live Voice Booking
 * Creation) WebSocket endpoint. Attached onto the raw http.Server
 * (server.js — Express itself cannot handle a WS upgrade, the reason
 * app.listen(PORT) became http.createServer(app) + server.listen(PORT)).
 *
 * Client -> server messages: `start_session {bookingType}`,
 * `audio_chunk {sessionId, chunk (base64), mimeType}`, `end_session
 * {sessionId}`. Server -> client: `session_started {sessionId}` (the PRD's
 * own message list didn't name how the client learns its sessionId — added
 * here, since audio_chunk/end_session both need one), `field_update
 * {sessionId, draftState}`, `transcript_update {sessionId, delta}`,
 * `session_ended {sessionId, fields, transcript, warnings}`, `session_error
 * {sessionId, message}`.
 *
 * Auth (B4.5) — token via `?token=` query param on the connection URL (the
 * PRD's own stated pattern), verified through the SAME real JWT-verify ->
 * subscription-enforcement -> permission-resolution pipeline
 * authenticateAccessToken's Express middleware uses
 * (middleware/authenticateAccessToken.js#resolveAuthFromAccessToken) —
 * never a second, parallel auth implementation.
 */
export const attachVoiceBookingWebSocketServer = (httpServer) => {
  const wss = new WebSocketServer({ server: httpServer, path: VOICE_BOOKING_WS_PATH });

  wss.on("connection", async (ws, request) => {
    // Pause the socket SYNCHRONOUSLY, before any await — resolveAuthFromAccessToken
    // below is a real DB round trip (subscription-enforcement + role/permission
    // lookup), and a client can legally send `start_session` the instant its
    // own `open` event fires, well before that resolves. ws.on("message", ...)
    // is only attached after auth succeeds; an EventEmitter with no listener
    // yet just drops an emitted event, so without this pause a message sent
    // in that window is silently lost forever and the client hangs waiting
    // for a reply that will never come — a real bug caught by this file's
    // own integration test (tests/bookingVoiceSocketServer.test.js), not a
    // hypothetical race.
    ws.pause();

    let auth;
    try {
      const url = new URL(request.url, "http://localhost");
      const token = url.searchParams.get("token");
      auth = await resolveAuthFromAccessToken(token, {
        onBlocked: (tenantId, block) => {
          // Fire-and-forget, same discipline as the Express middleware's
          // own onBlocked — must never add latency/block the close.
          TenantSubscriptionService.recordBlockedRequest(tenantId, { endpoint: `WS ${VOICE_BOOKING_WS_PATH}`, code: block.code });
        }
      });
    } catch (error) {
      const status = error instanceof AccessTokenError ? error.status : 401;
      send(ws, "session_error", { message: error.message || "Authentication failed.", status });
      // close() sends a close frame but still needs to READ the client's
      // answering close frame to finish the handshake — a paused socket
      // never processes that incoming frame, so the connection hangs
      // "closing" forever instead of actually closing. Must resume before
      // closing on every early-return path, not just the success path.
      ws.resume();
      ws.close(4001, "Unauthorized");
      return;
    }

    if (!auth.tenantId) {
      send(ws, "session_error", { message: "Tenant context is required.", status: 403 });
      ws.resume();
      ws.close(4003, "Forbidden");
      return;
    }
    if (!hasVoiceBookingPermission(auth.permissions)) {
      send(ws, "session_error", { message: "Permission denied.", status: 403 });
      ws.resume();
      ws.close(4003, "Forbidden");
      return;
    }

    let activeSessionId = null;

    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, "session_error", { message: "Malformed message — expected JSON." });
        return;
      }

      try {
        if (message.type === "start_session") {
          if (!SUPPORTED_VOICE_BOOKING_TYPES.includes(message.bookingType)) {
            send(ws, "session_error", { message: `Unsupported bookingType '${message.bookingType}'. Must be one of: ${SUPPORTED_VOICE_BOOKING_TYPES.join(", ")}.` });
            return;
          }
          activeSessionId = await BookingVoiceSessionService.startSession({ tenantId: auth.tenantId, bookingType: message.bookingType });
          send(ws, "session_started", { sessionId: activeSessionId });
          return;
        }

        if (message.type === "audio_chunk") {
          const sessionId = message.sessionId || activeSessionId;
          if (!sessionId) { send(ws, "session_error", { message: "No active session — send start_session first." }); return; }
          if (!message.chunk) { send(ws, "session_error", { sessionId, message: "audio_chunk requires a base64 'chunk'." }); return; }

          const audioChunkBuffer = Buffer.from(message.chunk, "base64");
          const { updatedDraftState, transcriptDelta } = await BookingVoiceSessionService.processChunk(sessionId, audioChunkBuffer, message.mimeType || "audio/webm");
          send(ws, "field_update", { sessionId, draftState: updatedDraftState });
          if (transcriptDelta) send(ws, "transcript_update", { sessionId, delta: transcriptDelta });
          return;
        }

        if (message.type === "end_session") {
          const sessionId = message.sessionId || activeSessionId;
          if (!sessionId) { send(ws, "session_error", { message: "No active session to end." }); return; }
          const result = await BookingVoiceSessionService.endSession(sessionId);
          send(ws, "session_ended", { sessionId, ...(result || { fields: null, transcript: null, warnings: [] }) });
          activeSessionId = null;
          return;
        }

        send(ws, "session_error", { message: `Unknown message type '${message.type}'.` });
      } catch (error) {
        send(ws, "session_error", { sessionId: message?.sessionId || activeSessionId || null, message: error.message || "Voice session error." });
      }
    });

    // Best-effort cleanup on an unclean disconnect (browser closed,
    // network drop) — BookingVoiceSessionService's own CacheManager TTL is
    // the real backstop (Acceptance Criteria #7), this just avoids leaving
    // a stale entry around for the full TTL when we already know the
    // session is over.
    ws.on("close", () => {
      if (activeSessionId) BookingVoiceSessionService.endSession(activeSessionId).catch(() => {});
    });

    // Only now, with every listener attached, resume the socket so nothing
    // sent during the auth round trip above is missed.
    ws.resume();
  });

  return wss;
};

export default attachVoiceBookingWebSocketServer;
