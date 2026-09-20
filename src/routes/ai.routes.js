import express from "express";
import { protectRoute } from "../middleware/auth.middleware.js";
import { askAIAboutChats } from "../controllers/ai.controller.js";

const router = express.Router();

router.post("/ask", protectRoute, askAIAboutChats);

export default router;
