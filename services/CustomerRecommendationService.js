import CustomerModel from "../models/CustomerModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import AIModelRouterService from "./ai/AIModelRouterService.js";

const stripJsonFence = (text) => (text || "{}").replace(/^```json\s*|\s*```$/g, "").trim();

/**
 * PRD "CRM Feature Map by Phase" Phase 4 module 27 (AI Smart System) —
 * "package/hotel suggestions... trained on customer history." A thin
 * composition over the already-built AI Model Router (real multi-provider
 * routing/failover/circuit-breaker), never a new ML pipeline. Same "honest
 * failure, never a fabricated response" discipline every other AI call site
 * in this codebase (e.g. services/BankReconciliationService.js) follows —
 * no configured provider means aiAvailable: false, not a 500 or a guess.
 */
class CustomerRecommendationService {
  static async getRecommendations(customerId, tenantId) {
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
    if (!customer) throw new Error("Customer not found.");

    const bookings = await BookingHeaderModel.find({ tenantId, customerId })
      .sort({ createdAt: -1 }).limit(10)
      .select("bookingType status travelDate totalAmount currency").lean();

    const historySummary = bookings.length > 0
      ? bookings.map((b) => `- ${b.bookingType}, status ${b.status}, travel date ${b.travelDate ? b.travelDate.toISOString().slice(0, 10) : "TBD"}, amount ${b.totalAmount} ${b.currency}`).join("\n")
      : "No prior bookings on file.";

    const prompt = `Customer: ${customer.firstName} ${customer.lastName || ""}, category "${customer.category}".\n\nBooking history (most recent first):\n${historySummary}\n\nSuggest up to 3 travel packages or hotel types this customer would likely be interested in booking next, each with a one-sentence reason grounded in the booking history above. Respond ONLY as JSON: {"recommendations": [{"suggestion": "...", "reason": "..."}]}`;
    const systemPrompt = "You are a travel-package recommendation assistant for a Hajj & Umrah travel agency's internal CRM. Base every suggestion strictly on the customer booking history provided in the user message — never invent bookings, dates, or facts not given there. If the history is empty, suggest general starter packages appropriate for a first-time pilgrim rather than fabricating a personalized history.";

    let llmResult;
    try {
      llmResult = await AIModelRouterService.route({ tenantId, category: "reasoning", messages: [{ role: "user", content: prompt }], tools: [], systemPrompt });
    } catch (error) {
      return { aiAvailable: false, recommendations: [], message: error.message };
    }

    try {
      const parsed = JSON.parse(stripJsonFence(llmResult.content));
      const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
      return { aiAvailable: true, recommendations, provider: llmResult.provider, model: llmResult.model };
    } catch {
      return { aiAvailable: true, recommendations: [], message: "The AI did not return a valid recommendation list." };
    }
  }
}

export default CustomerRecommendationService;
