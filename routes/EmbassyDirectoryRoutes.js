import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { embassyDirectorySchemas } from "../middleware/validateRequest.js";
import { listEmbassyContacts, createEmbassyContact, updateEmbassyContact } from "../controllers/EmbassyDirectoryController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});

router.use(authenticateAccessToken);

router.get("/", limiter, listEmbassyContacts);
router.post("/", limiter, validate(embassyDirectorySchemas.createEmbassyContact), createEmbassyContact);
router.patch("/:embassyId", limiter, validate(embassyDirectorySchemas.updateEmbassyContact), updateEmbassyContact);

export default router;
