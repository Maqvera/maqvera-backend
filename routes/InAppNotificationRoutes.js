import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  archiveNotification
} from "../controllers/InAppNotificationController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, message: "Too many requests to the Notification Platform APIs." }
});

router.use(authenticateAccessToken);

router.get("/", limiter, listNotifications);
router.get("/unread-count", limiter, getUnreadCount);
router.patch("/read-all", limiter, markAllNotificationsRead);
router.patch("/:notificationId/read", limiter, markNotificationRead);
router.patch("/:notificationId/archive", limiter, archiveNotification);

export default router;
