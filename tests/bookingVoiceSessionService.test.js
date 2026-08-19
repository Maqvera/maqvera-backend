import test from "node:test";
import assert from "node:assert/strict";
import BookingVoiceSessionService from "../services/BookingVoiceSessionService.js";
import OpenAIAdapter from "../services/ai/OpenAIAdapter.js";
import AIModelRouterService from "../services/ai/AIModelRouterService.js";

// Voice-Based Booking Creation PRD B4.7 — the correction-scenario test
// (below) is, per the execution prompt's own instruction, "the single most
// important test in this entire PRD." Mocking follows the same
// t.mock.method-on-the-real-class approach as
// tests/bookingDocumentParserService.test.js / tests/bookingVoiceParserService.test.js.
// CacheManager (BookingVoiceSessionService's session store) needs no setup
// here — its own `get adapter()` transparently falls back to the in-memory
// Map when .init() hasn't been called, exactly the "works without Redis"
// contract utils/cacheManager.js documents.

test("startSession rejects an unsupported bookingType before creating anything", async () => {
  await assert.rejects(() => BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "bogus" }), /Unsupported bookingType/);
});

test("processChunk throws a clear error for an unknown/expired session — never a silent no-op", async () => {
  await assert.rejects(() => BookingVoiceSessionService.processChunk("not-a-real-session-id", Buffer.from("x"), "audio/webm"), /Voice session not found or expired/);
});

test("processChunk applies a 'set' operation to an empty draft", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "hotel name Grand Palace", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async ({ tools }) => {
    assert.equal(tools[0].name, "apply_field_patch");
    return { toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "hotelName", op: "set", value: "Grand Palace" }] } }] };
  });

  const sessionId = await BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "hotel" });
  const { updatedDraftState } = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("chunk1"), "audio/webm");

  assert.equal(updatedDraftState.hotelName, "Grand Palace");
  await BookingVoiceSessionService.endSession(sessionId);
});

// THE exact scenario from the PRD/business owner: "check-in 20 August" then
// "no wait, 21 August" -> the SAME field gets corrected live, no
// duplicate/conflicting entry, no re-recording.
test("processChunk handles a live correction: 'check-in 20 August' then 'no wait, 21 August' updates the SAME field, not a duplicate", async (t) => {
  let callCount = 0;
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => {
    callCount += 1;
    return callCount === 1
      ? { text: "check-in 20 August", detectedLanguage: "en" }
      : { text: "no wait, 21 August", detectedLanguage: "en" };
  });
  t.mock.method(AIModelRouterService, "route", async ({ messages }) => {
    const prompt = messages[0].content;
    if (prompt.includes("no wait, 21 August")) {
      // The AI is given the current draft state (checkIn already "2026-08-20")
      // plus the full transcript — asserting it actually received both.
      assert.match(prompt, /checkIn.*2026-08-20/s, "the patch call must include the CURRENT draft state, not just the new chunk");
      return { toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "checkIn", op: "set", value: "2026-08-21" }] } }] };
    }
    return { toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "checkIn", op: "set", value: "2026-08-20" }] } }] };
  });

  const sessionId = await BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "hotel" });

  const first = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("chunk1"), "audio/webm");
  assert.equal(first.updatedDraftState.checkIn, "2026-08-20");

  const second = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("chunk2"), "audio/webm");
  assert.equal(second.updatedDraftState.checkIn, "2026-08-21", "field must be corrected in place");
  assert.equal(Object.keys(second.updatedDraftState).length, 1, "must not produce a second/duplicate field entry for the same correction");

  const final = await BookingVoiceSessionService.endSession(sessionId);
  assert.equal(final.fields.checkIn.toISOString().slice(0, 10), "2026-08-21");
});

test("processChunk applies a 'clear' operation, removing a previously-set field from the draft", async (t) => {
  let callCount = 0;
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => { callCount += 1; return { text: `chunk ${callCount}`, detectedLanguage: "en" }; });
  t.mock.method(AIModelRouterService, "route", async () => (
    callCount === 1
      ? { toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "roomType", op: "set", value: "Deluxe Twin" }] } }] }
      : { toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "roomType", op: "clear", value: null }] } }] }
  ));

  const sessionId = await BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "hotel" });
  const preset = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("preset"), "audio/webm");
  assert.equal(preset.updatedDraftState.roomType, "Deluxe Twin");

  const { updatedDraftState } = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("clear-chunk"), "audio/webm");
  assert.equal(Object.prototype.hasOwnProperty.call(updatedDraftState, "roomType"), false);
});

test("processChunk ignores a patch operation referencing an unknown field name (defense)", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "something", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async () => ({
    toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "notARealField", op: "set", value: "x" }] } }]
  }));

  const sessionId = await BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "hotel" });
  const { updatedDraftState } = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("chunk"), "audio/webm");

  assert.deepEqual(updatedDraftState, {});
});

test("processChunk returns unchanged draft on silent/empty audio, never calls the AI", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "", detectedLanguage: null }));
  let routeCalled = false;
  t.mock.method(AIModelRouterService, "route", async () => { routeCalled = true; return { toolCalls: [] }; });

  const sessionId = await BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "hotel" });
  const { updatedDraftState, transcriptDelta } = await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("silence"), "audio/webm");

  assert.deepEqual(updatedDraftState, {});
  assert.equal(transcriptDelta, "");
  assert.equal(routeCalled, false);
});

test("endSession returns the final typed field set (same shape as Mode A) and removes the session", async (t) => {
  t.mock.method(OpenAIAdapter.prototype, "transcribeAudio", async () => ({ text: "2 pax", detectedLanguage: "en" }));
  t.mock.method(AIModelRouterService, "route", async () => ({ toolCalls: [{ name: "apply_field_patch", arguments: { operations: [{ field: "pax", op: "set", value: 2 }] } }] }));

  const sessionId = await BookingVoiceSessionService.startSession({ tenantId: "t1", bookingType: "hotel" });
  await BookingVoiceSessionService.processChunk(sessionId, Buffer.from("chunk"), "audio/webm");

  const result = await BookingVoiceSessionService.endSession(sessionId);
  assert.equal(result.fields.pax, 2);
  assert.deepEqual(result.warnings, []);

  // Session removed — a second processChunk against the same id must throw.
  await assert.rejects(() => BookingVoiceSessionService.processChunk(sessionId, Buffer.from("x"), "audio/webm"), /Voice session not found or expired/);
});

test("endSession on an already-ended/unknown session returns null, never throws", async () => {
  const result = await BookingVoiceSessionService.endSession("never-existed");
  assert.equal(result, null);
});
