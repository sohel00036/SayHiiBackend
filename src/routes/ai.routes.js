import express from "express";
import { protectRoute } from "../middleware/auth.middleware.js";
import { askAIAboutChats, agentChat, getTasks, toggleTask, deleteTask } from "../controllers/ai.controller.js";

const router = express.Router();

// Phase 2: RAG chat search (unchanged)
router.post("/ask", protectRoute, askAIAboutChats);

// Phase 3: AI Agent
router.post("/agent", protectRoute, agentChat);

// Phase 3: Task CRUD
router.get("/tasks", protectRoute, getTasks);
router.patch("/tasks/:id/toggle", protectRoute, toggleTask);
router.delete("/tasks/:id", protectRoute, deleteTask);

export default router;
