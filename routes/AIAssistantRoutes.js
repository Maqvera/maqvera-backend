import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  AIChat,
  AIFlightSearch,
  AIHotelSearch,
  AIPackageSearch,
  AITravelPlan,
  AIDashboard,
  AIAnalytics,
  AISearch,
  AIExplain,
  AISummarize,
  AIRecommend,
  ListAIConversations,
  ArchiveAIConversation,
  GetAIConversationContext,
  ClearAIConversationContext,
  GetAIProviderStatus,
  GetAIAgents,
  TransitionAgentState,
  AISupervisorChat
} from "../controllers/AIAssistantController.js";

const router = express.Router();

// "AI Security... Rate Limiting" — LLM calls are expensive (cost + latency),
// so this module gets a tighter window than the standard 100/10min used
// elsewhere in the ERP.
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

router.post("/chat", AIChat);
router.post("/flight-search", AIFlightSearch);
router.post("/hotel-search", AIHotelSearch);
router.post("/package-search", AIPackageSearch);
router.post("/travel-plan", AITravelPlan);
router.post("/dashboard", AIDashboard);
router.post("/analytics", AIAnalytics);
router.post("/search", AISearch);
router.post("/explain", AIExplain);
router.post("/summarize", AISummarize);
router.post("/recommend", AIRecommend);
router.get("/conversations", ListAIConversations);
router.post("/conversations/:conversationId/archive", ArchiveAIConversation);
router.get("/conversations/:conversationId/context", GetAIConversationContext);
router.post("/conversations/:conversationId/context/clear", ClearAIConversationContext);
router.post("/supervisor", AISupervisorChat);
router.get("/providers/status", GetAIProviderStatus);
router.get("/agents", GetAIAgents);
router.patch("/agents/:agentId/state", TransitionAgentState);

export default router;
