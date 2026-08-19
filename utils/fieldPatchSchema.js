// Voice-Based Booking Creation PRD B4.2 — Mode B's (Live Voice Booking)
// shared PATCH tool. One tool schema for every bookingType — the type-aware
// part is the `field` enum (built per call from that type's own field
// list) and the system prompt's plain-language field description, not a
// separate tool per type. This is the crux of the correction-handling
// feature ("check-in 20 August... no wait, 21 August" -> the SAME field
// gets a corrected `set`, never a second/duplicate entry) — see
// services/BookingVoiceSessionService.js for how it's actually driven.
export const buildFieldPatchTool = (fieldNames) => ({
  name: "apply_field_patch",
  description: "Given the current draft field values and the full spoken/transcribed conversation so far, return the operations needed to bring the draft up to date with what was actually said — including corrections and retractions. Only include an operation for a field that genuinely needs to change; omit fields that are already correct or still unspoken.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: fieldNames, description: "Field name — must be exactly one of the valid field names given to you." },
            op: { type: "string", enum: ["set", "clear"] },
            value: { type: ["string", "number", "null"] }
          },
          required: ["field", "op", "value"]
        }
      }
    },
    required: ["operations"]
  }
});

/**
 * `fieldNames`/`typeLabel` are per-bookingType (from
 * utils/voiceBookingExtractionRegistry.js); the correction-handling
 * instruction itself is shared verbatim across every type, since the
 * behavior it describes (don't duplicate on a correction, honor an
 * explicit "clear/remove/skip this field" as `clear`) is identical
 * regardless of what's being booked.
 */
export const buildFieldPatchSystemPrompt = (typeLabel, fieldNames) => (
  `You are live-transcribing a travel agency employee dictating a ${typeLabel} booking, field by field, and keeping a draft form in sync with what they say as they speak. ` +
  `Valid field names for this booking type: ${fieldNames.join(", ")}. ` +
  "Call apply_field_patch exactly once with only the operations needed to bring the draft up to date with the full transcript so far, given the current draft state you were also given. " +
  "If the speaker corrects or retracts something they said earlier (e.g. 'no wait,' 'actually,' 'I meant'), emit a single `set` operation for that field with the corrected value — do not emit a second, duplicate, or conflicting entry for the same field. " +
  "If the speaker says to remove, skip, or clear a field, emit `clear` for it. " +
  "Never invent an operation for something not actually said, and never re-emit an operation for a field that is already correct in the current draft state."
);
