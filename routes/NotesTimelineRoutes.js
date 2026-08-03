import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import rateLimit from "express-rate-limit";
import {
  UpdateTravelNote,
  DeleteTravelNote,
  AddTimelineAttachment
} from "../controllers/TravelNotesTimelineController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Notes & Timeline Standalone Routes
router.patch("/notes/:noteId", limiter, UpdateTravelNote);
router.delete("/notes/:noteId", limiter, DeleteTravelNote);
router.post("/timeline/:timelineEventId/attachments", limiter, AddTimelineAttachment);

export default router;
