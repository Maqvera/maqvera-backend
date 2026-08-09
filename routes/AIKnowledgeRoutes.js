import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import {
  uploadKnowledgeFile,
  CreateKnowledgeDocument,
  UpdateKnowledgeDocument,
  ArchiveKnowledgeDocument,
  ListKnowledgeDocuments,
  GetKnowledgeDocumentById,
  SearchKnowledgeBase
} from "../controllers/AIKnowledgeController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many AI knowledge requests from this IP, please try again after 10 minutes."
});

router.use(authenticateAccessToken, limiter);

// Fixed-segment route registered before the "/:documentId" wildcard.
router.post("/search", SearchKnowledgeBase);
router.post("/", uploadKnowledgeFile, CreateKnowledgeDocument);
router.get("/", ListKnowledgeDocuments);
router.put("/:documentId", UpdateKnowledgeDocument);
router.delete("/:documentId", ArchiveKnowledgeDocument);
router.get("/:documentId", GetKnowledgeDocumentById);

export default router;
