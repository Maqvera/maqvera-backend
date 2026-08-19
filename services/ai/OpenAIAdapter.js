import OpenAI, { toFile } from "openai";
import BaseAIProviderAdapter from "./BaseAIProviderAdapter.js";
import { getAIConfig } from "../../utils/aiConfig.js";

// Voice-Based Booking Creation PRD B3.1 — maps the mime types a browser's
// MediaRecorder (Mode A upload) or streamed chunks (Mode B) realistically
// produce onto a file extension, since OpenAI's transcription endpoint
// infers format from the uploaded filename, not the mime type alone.
const AUDIO_MIME_TO_EXTENSION = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac"
};

/**
 * Real OpenAI Chat Completions adapter with native function/tool calling.
 * Returns `configured: false` behavior (via a thrown, clearly-labeled
 * error) when no API key is set — the orchestrator surfaces this as an
 * honest "AI service not configured" response, never a fabricated answer.
 */
class OpenAIAdapter extends BaseAIProviderAdapter {
  constructor() {
    super("OpenAI");
    const config = getAIConfig();
    this.config = config.openai;
    this.client = this.config.apiKey
      ? new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, timeout: config.requestTimeoutMs })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  /** EXT-034 — `model` optionally overrides the configured OPENAI_MODEL for this one call (how AIModelRouterService pins a specific A/B-test variant). */
  async chatWithTools({ messages, tools = [], systemPrompt, model }) {
    if (!this.client) {
      throw new Error("OpenAI provider is not configured (OPENAI_API_KEY missing).");
    }

    const openAiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content }))
    ];

    const openAiTools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));

    const response = await this.client.chat.completions.create({
      model: model || this.config.model,
      messages: openAiMessages,
      tools: openAiTools.length > 0 ? openAiTools : undefined,
      max_tokens: getAIConfig().maxOutputTokens
    });

    const choice = response.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls || []).map((call) => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      return { id: call.id, name: call.function.name, arguments: args };
    });

    return {
      content: choice?.message?.content || null,
      toolCalls,
      finishReason: choice?.finish_reason || "stop",
      usage: response.usage || {}
    };
  }

  /**
   * Voice-Based Booking Creation PRD B3.1/B4 — real OpenAI Whisper
   * transcription (`audio.transcriptions.create`), same already-configured
   * client/apiKey chatWithTools uses, no second credential path. No
   * `language` param — Whisper auto-detects (B5.2: employees speak a mix
   * of languages; forcing one would silently mistranscribe the others).
   * `response_format: "verbose_json"` is what surfaces the detected
   * language back to the caller. Never throws on empty/silent audio
   * (returns an honest empty transcript instead) — only a genuine
   * configuration/API failure throws, caught by the calling service's own
   * try/catch (same discipline as chatWithTools/BookingDocumentParserService).
   */
  async transcribeAudio({ audioBuffer, mimeType }) {
    if (!this.client) {
      throw new Error("OpenAI provider is not configured (OPENAI_API_KEY missing).");
    }
    if (!audioBuffer?.length) {
      return { text: "", detectedLanguage: null };
    }

    const extension = AUDIO_MIME_TO_EXTENSION[mimeType] || "webm";
    const file = await toFile(audioBuffer, `audio.${extension}`, { type: mimeType || "application/octet-stream" });

    const response = await this.client.audio.transcriptions.create({
      file,
      model: this.config.transcriptionModel,
      response_format: "verbose_json"
    });

    return { text: response.text || "", detectedLanguage: response.language || null };
  }

  async checkHealth() {
    return { provider: this.providerName, status: this.isConfigured() ? "UP" : "NOT_CONFIGURED", model: this.config.model };
  }
}

export default OpenAIAdapter;
