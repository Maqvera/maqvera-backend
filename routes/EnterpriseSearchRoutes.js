import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import rateLimit from "express-rate-limit";
import {
  GlobalSearch,
  GetSearchSuggestions,
  SaveSearchQuery,
  ListSavedSearches,
  DeleteSavedSearch
} from "../controllers/EnterpriseSearchController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken);

// Enterprise Search Routes (Part 11)
router.get("/suggestions", limiter, GetSearchSuggestions);
router.post("/saved", limiter, SaveSearchQuery);
router.get("/saved", limiter, ListSavedSearches);
router.delete("/saved/:savedSearchId", limiter, DeleteSavedSearch);
router.get("/visa-cases", limiter, (req, _res, next) => { req.query.entityType = "VisaCase"; next(); }, GlobalSearch);
router.get("/travelers", limiter, (req, _res, next) => { req.query.entityType = "Traveler"; next(); }, GlobalSearch);
router.get("/passports", limiter, (req, _res, next) => { req.query.entityType = "Passport"; next(); }, GlobalSearch);
router.get("/documents", limiter, (req, _res, next) => { req.query.entityType = "Document"; next(); }, GlobalSearch);
router.get("/incidents", limiter, (req, _res, next) => { req.query.entityType = "Incident"; next(); }, GlobalSearch);
router.get("/appointments", limiter, (req, _res, next) => { req.query.entityType = "Appointment"; next(); }, GlobalSearch);
router.get("/embassies", limiter, (req, _res, next) => { req.query.entityType = "EmbassySubmission"; next(); }, GlobalSearch);
router.get("/", limiter, GlobalSearch);

export default router;
