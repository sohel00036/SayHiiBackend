import { generateRAGAnswer, retrieveRelevantMessages } from "../lib/ai.service.js";
import { runAgent } from "../lib/agent.service.js";
import { checkAndIncrementAiQuota } from "../middleware/aiQuota.middleware.js";
import Task from "../models/task.model.js";

/**
 * Controller to answer natural-language questions about user's past chats using Vector RAG Search.
 * (Phase 2 — unchanged behavior, refactored to use shared retrieval helper)
 */
export const askAIAboutChats = async (req, res) => {
  try {
    const { query } = req.body;
    const userId = req.user._id;

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ message: "Search query is required." });
    }

    // Check AI daily quota
    const quotaCheck = await checkAndIncrementAiQuota(userId);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ message: quotaCheck.message });
    }

    // 1. Retrieve relevant messages using shared helper (same vector search + fallback)
    const matchingMessages = await retrieveRelevantMessages(userId.toString(), query);

    // 2. Generate grounded answer using Gemini LLM
    const answer = await generateRAGAnswer(query, matchingMessages);

    // 3. Format source citations for response
    const sources = matchingMessages.map((msg) => ({
      _id: msg._id,
      text: msg.text,
      senderName: msg.sender?.fullName || "User",
      receiverName: msg.receiver?.fullName || "User",
      senderPic: msg.sender?.profilePic || "/avatar.png",
      createdAt: msg.createdAt,
    }));

    return res.status(200).json({
      answer,
      sources,
    });
  } catch (error) {
    console.error("Error in askAIAboutChats controller:", error);
    return res.status(500).json({ message: "Failed to process chat search request." });
  }
};

/**
 * Phase 3 AI Agent endpoint.
 * Accepts a natural-language query and delegates to the LangChain agent,
 * which decides which tool(s) to invoke (summarize, extract tasks, draft reply).
 */
export const agentChat = async (req, res) => {
  try {
    const query = req.body.query || req.body.instruction;
    const { targetUserId } = req.body;
    const userId = req.user._id;
    const userName = req.user.fullName;

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ message: "Query is required." });
    }

    // Check AI daily quota
    const quotaCheck = await checkAndIncrementAiQuota(userId);
    if (!quotaCheck.allowed) {
      return res.status(429).json({ message: quotaCheck.message });
    }

    // Run the agent — it will decide which tool(s) to call
    const agentResult = await runAgent(userId.toString(), userName, query.trim(), targetUserId);

    return res.status(200).json(agentResult);
  } catch (error) {
    console.error("Error in agentChat controller:", error);
    return res.status(500).json({ message: "Failed to process agent request." });
  }
};

/**
 * Get all tasks for the authenticated user.
 */
export const getTasks = async (req, res) => {
  try {
    const userId = req.user._id;
    const tasks = await Task.find({ userId }).sort({ createdAt: -1 });
    return res.status(200).json(tasks);
  } catch (error) {
    console.error("Error in getTasks controller:", error);
    return res.status(500).json({ message: "Failed to fetch tasks." });
  }
};

/**
 * Toggle a task's completion status.
 */
export const toggleTask = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const task = await Task.findOne({ _id: id, userId });
    if (!task) {
      return res.status(404).json({ message: "Task not found." });
    }

    task.completed = !task.completed;
    task.isCompleted = task.completed;
    await task.save();

    return res.status(200).json(task);
  } catch (error) {
    console.error("Error in toggleTask controller:", error);
    return res.status(500).json({ message: "Failed to update task." });
  }
};

/**
 * Delete a task.
 */
export const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const task = await Task.findOneAndDelete({ _id: id, userId });
    if (!task) {
      return res.status(404).json({ message: "Task not found." });
    }

    return res.status(200).json({ message: "Task deleted." });
  } catch (error) {
    console.error("Error in deleteTask controller:", error);
    return res.status(500).json({ message: "Failed to delete task." });
  }
};
