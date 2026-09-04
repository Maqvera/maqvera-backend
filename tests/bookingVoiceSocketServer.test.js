import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import http from "http";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { WebSocket } from "ws";
import { getAuthConfig } from "../utils/authConfig.js";
import OpenAIAdapter from "../services/ai/OpenAIAdapter.js";
import AIModelRouterService from "../services/ai/AIModelRouterService.js";
import { attachVoiceBookingWebSocketServer } from "../services/BookingVoiceSocketServer.js";

dotenv.config();

// Voice-Based Booking Creation PRD B4 — real end-to-end wire-protocol test
// (real http.Server + real `ws` client + real JWT verification), not just
// BookingVoiceSessionService's own unit tests. Same live-DB skip-guard
// convention as tests/bookingVoucherService.test.js (a Role lookup for
// permissions genuinely needs Mongo) — skips cleanly, never hangs, when no
// MONGO_URI/URI is configured.
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const openConnectionAndCollect = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on("open", () => resolve({ ws, messages }));
  ws.on("error", reject);
});

const waitForMessageType = (messages, type, timeoutMs = 3000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const check = () => {
    const found = messages.find((m) => m.type === type);
    if (found) return resolve(found);
    if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for message type '${type}'. Got: ${JSON.stringify(messages)}`));
    setTimeout(check, 20);
  };
  check();
});

test("Mode B WebSocket: full start_session -> audio_chunk -> end_session round trip over a real connection", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const RoleModel = (await import("../models/Rolemodel.js")).default;

  const suffix = `wsvoice-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  await RoleModel.create({ tenantId, name: "Booking Agent", permissions: ["bookings.create"], status: "active" });
  t.after(async () => { await RoleModel.deleteMany({ tenantId }); });

  const { accessTokenSecret } = getAuthConfig();
  const token = jwt.sign({ type: "access", tenantId, userId: "u1", role: "Booking Agent" }, accessTokenSecret, { expiresIn: "5m" });

  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "guest John Doe", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async () => ({
    toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "guestName", op: "set", value: "John Doe" }] } }]
  }));

  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  attachVoiceBookingWebSocketServer(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const { ws, messages } = await openConnectionAndCollect(`ws://127.0.0.1:${port}/ws/voice-booking?token=${token}`);

    ws.send(JSON.stringify({ type: "start_session", bookingType: "hotel" }));
    const started = await waitForMessageType(messages, "session_started");
    assert.ok(started.sessionId, "server must hand back a real sessionId");

    ws.send(JSON.stringify({ type: "audio_chunk", sessionId: started.sessionId, chunk: Buffer.from("fake-audio").toString("base64"), mimeType: "audio/webm" }));
    const fieldUpdate = await waitForMessageType(messages, "field_update");
    assert.equal(fieldUpdate.draftState.guestName, "John Doe", "field must live-update from the mocked AI patch");

    ws.send(JSON.stringify({ type: "end_session", sessionId: started.sessionId }));
    const ended = await waitForMessageType(messages, "session_ended");
    assert.equal(ended.fields.guestName, "John Doe");
    assert.deepEqual(ended.warnings, []);

    // .terminate() (immediate socket destroy) rather than .close() (a
    // graceful closing handshake) — a server-initiated close right before
    // the client also closes can otherwise leave the underlying socket
    // lingering long enough for httpServer.close()'s callback to wait out
    // Node's default keep-alive/idle timeout, making an otherwise-instant
    // test take ~30s. Test-cleanup speed only; irrelevant to the real
    // server's normal operation, which never needs to httpServer.close().
    ws.terminate();
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("Mode B WebSocket: rejects a connection with no/invalid token", async () => {
  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  attachVoiceBookingWebSocketServer(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const { ws, messages } = await openConnectionAndCollect(`ws://127.0.0.1:${port}/ws/voice-booking`);
    const error = await waitForMessageType(messages, "session_error");
    assert.match(error.message, /Missing JWT/);
    // .terminate() (immediate socket destroy) rather than .close() (a
    // graceful closing handshake) — a server-initiated close right before
    // the client also closes can otherwise leave the underlying socket
    // lingering long enough for httpServer.close()'s callback to wait out
    // Node's default keep-alive/idle timeout, making an otherwise-instant
    // test take ~30s. Test-cleanup speed only; irrelevant to the real
    // server's normal operation, which never needs to httpServer.close().
    ws.terminate();
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
