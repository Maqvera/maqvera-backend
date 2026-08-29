import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { reviewSchemas } from "../middleware/validateRequest.js";
import { createReview, listReviews, moderateReview } from "../controllers/ReviewController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.use(authenticateAccessToken);

router.get("/", limiter, listReviews);
router.post("/", limiter, validate(reviewSchemas.createReview), createReview);
router.patch("/:reviewId/moderate", limiter, validate(reviewSchemas.moderateReview), moderateReview);

export default router;
