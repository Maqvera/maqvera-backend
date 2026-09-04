import OpenAIAdapter from "./ai/OpenAIAdapter.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";
import { resolveExtractionSchema } from "../utils/voiceBookingExtractionRegistry.js";

const openAIAdapter = new OpenAIAdapter();

/**
 * Voice-Based Booking Creation PRD B3 — Mode A (Record -> Upload ->
 * Confirm). Same "extraction only, never saves anything" and
 * Skipped/Failed/Completed status contract as
 * BookingDocumentParserService.parseHotelDocument — this is that service's
 * sibling, a new INPUT CHANNEL into the same
 * utils/voiceBookingExtractionRegistry.js convergence point (PRD B1), not a
 * parallel pipeline. Never throws.
 */
class BookingVoiceParserService {
  /**
   * @param {Buffer} audioBuffer
   * @param {string} mimeType
   * @param {string} tenantId
   * @param {string} bookingType — "hotel" | "car_rental" | "flight_search" | "generic_service"
   */
  static async parseVoiceBooking(audioBuffer, mimeType, tenantId, bookingType) {
    try {
      const { tool, systemPrompt, mapFields, validate } = resolveExtractionSchema(bookingType);

      const { text: transcript } = await openAIAdapter.transcribeAudio({ audioBuffer, mimeType });
      if (!transcript?.trim()) {
        return { status: "Skipped", transcript: "", fields: null, warnings: [], processedAt: new Date() };
      }

      const { toolCalls } = await AIModelRouterService.route({
        tenantId,
        category: "reasoning",
        messages: [{
          role: "user",
          content: `Extract booking fields from this spoken description (transcribed from voice, may include filler words, spoken-out numbers, informal phrasing, mixed languages):\n\n${transcript}`
        }],
        tools: [tool],
        systemPrompt
      });

      const call = (toolCalls || []).find((c) => c.name === tool.name);
      if (!call) throw new Error(`AI provider did not return the expected ${tool.name} tool call.`);

      const fields = mapFields(call.arguments || {});

      return { status: "Completed", transcript, fields, warnings: validate(fields), processedAt: new Date() };
    } catch (error) {
      return { status: "Failed", transcript: null, fields: null, warnings: [], processedAt: new Date(), error: error.message };
    }
  }
}

export default BookingVoiceParserService;
