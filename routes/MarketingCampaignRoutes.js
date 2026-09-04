import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { marketingCampaignSchemas } from "../middleware/validateRequest.js";
import { CreateCampaign, ListCampaigns, GetCampaign, SendCampaign, GetCampaignAnalytics } from "../controllers/MarketingCampaignController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.use(authenticateAccessToken);

router.post("/", limiter, validate(marketingCampaignSchemas.createCampaign), CreateCampaign);
router.get("/", limiter, ListCampaigns);
router.get("/:campaignId", limiter, GetCampaign);
router.post("/:campaignId/send", limiter, SendCampaign);
router.get("/:campaignId/analytics", limiter, GetCampaignAnalytics);

export default router;
