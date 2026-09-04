import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { clockIn, clockOut, getAttendance } from "../controllers/EmployeeAttendanceController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.use(authenticateAccessToken);

router.post("/clock-in", limiter, clockIn);
router.post("/clock-out", limiter, clockOut);
router.get("/:employeeId", limiter, getAttendance);

export default router;
