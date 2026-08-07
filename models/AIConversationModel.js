import mongoose from "mongoose";

const AIConversationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, default: "main", index: true },
    userId: { type: String, required: true, index: true },
    mode: {
      type: String,
      enum: ["Assistant", "Operations", "Management", "Customer", "Finance", "Support", "Developer"],
      default: "Assistant"
    },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    messages: [
      {
        role: { type: String, enum: ["user", "assistant", "tool"], required: true },
        content: { type: String, default: "" },
        toolName: { type: String, default: null },
        toolArguments: { type: mongoose.Schema.Types.Mixed, default: null },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    toolExecutions: [
      {
        toolName: { type: String, required: true },
        arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
        succeeded: { type: Boolean, default: true },
        durationMs: { type: Number, default: 0 },
        executedAt: { type: Date, default: Date.now }
      }
    ],
    provider: { type: String, default: null },
    // "Confidence Score", "Source Attribution" — real, derived signals
    // (not fabricated certainty): confidence reflects whether the answer
    // was grounded in at least one successful tool call; sources list which
    // internal APIs actually backed the answer.
    lastConfidenceScore: { type: Number, default: null },
    lastSources: [{ type: String }],
    flaggedPromptInjection: { type: Boolean, default: false },
    summary: { type: String, default: null },
    archivedAt: { type: Date, default: null },
    // EXT-027 "AI Agent Memory & Conversation Context" — session-scoped,
    // structured memory, distinct from `messages`/`toolExecutions` above
    // (a raw transcript/audit log, not something the AI can reuse across
    // turns: AIAssistantService.chat() only ever fed prior user/assistant
    // TEXT back into the LLM, never the actual tool results, so a
    // follow-up like "only refundable" had nothing structured to reuse and
    // either re-asked the user or the model guessed from its own prior
    // prose). Every field here maps to a real tool parameter/result this
    // codebase actually has — see services/ai/AIContextMemory.js for which
    // tool populates which field, and its docblock for the fields that are
    // schema-ready but currently have no tool to populate them (honestly
    // left null, never fabricated). Deliberately excludes anything EXT-027
    // §11 forbids (passwords, OAuth tokens, payment card data) — those
    // categories have no field here at all, which is the enforcement.
    // Deliberately NOT a customer profile/CRM/booking-history record (see
    // EXT-027's own "Architecture Note") — cleared on manual clear or
    // session-idle expiry, never promoted into a permanent store.
    context: {
      currentTopic: { type: String, default: null },
      currentIntent: { type: String, default: null },
      language: { type: String, default: null },
      flight: {
        origin: { type: String, default: null },
        destination: { type: String, default: null },
        departureDate: { type: String, default: null },
        returnDate: { type: String, default: null },
        adults: { type: Number, default: null },
        cabin: { type: String, default: null },
        budget: { type: Number, default: null },
        preferredAirline: { type: String, default: null },
        selectedOfferId: { type: String, default: null },
        selectedProvider: { type: String, default: null },
        // No current tool in this codebase returns a distinct "pricing
        // token" separate from the offer ID itself (real Amadeus flight
        // pricing here is keyed by offerId — see GdsIntegrationService) —
        // schema-ready, honestly always null until such a tool exists.
        pricingToken: { type: String, default: null },
        searchedAt: { type: Date, default: null }
      },
      hotel: {
        city: { type: String, default: null },
        checkIn: { type: String, default: null },
        checkOut: { type: String, default: null },
        guests: { type: Number, default: null },
        rooms: { type: Number, default: null },
        // No current tool accepts a meal-plan filter as a search input
        // (mealPlan is part of an OFFER's own response, not a request
        // param) — captured for conversational continuity only.
        mealPreference: { type: String, default: null },
        starRating: { type: Number, default: null },
        selectedHotelId: { type: String, default: null },
        selectedOfferId: { type: String, default: null },
        searchedAt: { type: Date, default: null }
      },
      // No tool in this catalog accepts children/infants/nationality/
      // special-assistance/wheelchair/meal-request as input — these fields
      // are schema-ready for when such a tool exists, honestly unpopulated
      // today rather than fabricated from guesswork.
      passengers: {
        adults: { type: Number, default: null },
        children: { type: Number, default: null },
        infants: { type: Number, default: null },
        nationality: { type: String, default: null },
        passportAvailable: { type: Boolean, default: null },
        specialAssistance: { type: String, default: null },
        wheelchairRequest: { type: Boolean, default: null },
        mealRequest: { type: String, default: null }
      },
      // No real PNR/payment-status field exists at this layer — a
      // propose_* tool only ever creates a pending AIApprovalRequestModel
      // row (see AIToolRegistry.js), it never reaches real PNR issuance or
      // payment, so those doc-named fields are honestly not modeled here;
      // this tracks the one real, existing artifact — which approval
      // request (if any) is currently pending for this session's flight/
      // hotel proposal.
      booking: {
        flightApprovalRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "AIApprovalRequest", default: null },
        hotelApprovalRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "AIApprovalRequest", default: null },
        hotelCancellationApprovalRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "AIApprovalRequest", default: null }
      },
      // "Expired sessions automatically removed... Default timeout
      // configurable." Refreshed on every turn; a sweep
      // (aiContextExpiryScheduler.js) clears (not deletes the conversation)
      // once this passes — see services/ai/AIContextMemory.js.
      expiresAt: { type: Date, default: null }
    }
  },
  { timestamps: true }
);

AIConversationSchema.index({ tenantId: 1, userId: 1, status: 1, updatedAt: -1 });

export default mongoose.models.AIConversation || mongoose.model("AIConversation", AIConversationSchema);
