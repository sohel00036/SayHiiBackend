import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { SystemMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import mongoose from "mongoose";

import { retrieveRelevantMessages, formatMessagesAsContext } from "./ai.service.js";
import Task from "../models/task.model.js";
import Message from "../models/message.model.js";
import User from "../models/user.model.js";

/**
 * Phase 3 AI Agent Service for SayHii.
 * Uses LangChain's ChatGoogleGenerativeAI with tool binding to orchestrate:
 *  1. Conversation summarization
 *  2. Action item / task extraction
 *  3. Style-aware draft reply generation
 *
 * The agent decides which tool(s) to invoke based on the user's plain-language request.
 * Reuses the shared retrieveRelevantMessages helper from ai.service.js.
 */

/**
 * Helper to get ChatGoogleGenerativeAI model instance for LangChain.
 */
function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing from environment variables.");
  }
  return new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    apiKey,
  });
}

/**
 * Resolves a contact name to their MongoDB ObjectId by fuzzy-matching fullName.
 * Returns null if no match found.
 */
async function resolveContactId(contactName) {
  if (!contactName || !contactName.trim()) return null;
  try {
    const user = await User.findOne({
      fullName: { $regex: new RegExp(contactName.trim(), "i") },
    }).select("_id");
    return user?._id?.toString() || null;
  } catch {
    return null;
  }
}

/**
 * Creates the 3 tools scoped to a specific user context.
 * Each tool receives userId and userName via closure so the agent doesn't need to know them.
 */
function createTools(userId, userName) {
  // -------------------------------------------------------------------
  // Tool 1: Summarize Conversation
  // -------------------------------------------------------------------
  const summarizeConversation = tool(
    async ({ contactName, timeframeDays, customFocus }) => {
      try {
        let contactObjId = null;
        if (contactName) {
          contactObjId = await resolveContactId(contactName);
        }

        const messages = await retrieveRelevantMessages({
          userId,
          query: customFocus || (contactName ? `conversation with ${contactName}` : "recent chat history key points"),
          limit: 35,
          contactId: contactObjId,
        });

        if (!messages || messages.length === 0) {
          return `No relevant messages found to summarize ${contactName ? `for contact "${contactName}"` : "in your chat history"}.`;
        }

        const contextText = formatMessagesAsContext(messages);
        const model = getModel();

        const prompt = `You are a conversation summarization expert. Below is a set of past messages involving user "${userName}".
${contactName ? `Specific Contact requested: ${contactName}` : ""}
${customFocus ? `User Focus: ${customFocus}` : ""}

MESSAGES:
${contextText}

Generate a clear, beautifully structured summary with:
1. Executive Summary (2-3 sentences)
2. Main Discussion Topics (bullet points)
3. Key Decisions Made (bullet points if any)
4. Key Action Items / Follow-ups (if any)

Format using markdown with emoji headers.`;

        const res = await model.invoke(prompt);
        return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      } catch (err) {
        console.error("Error in summarizeConversation tool:", err);
        return `Failed to summarize conversation: ${err.message}`;
      }
    },
    {
      name: "summarize_conversation",
      description: "Summarize a conversation or chat thread with a specific contact or across recent chats. Generates key takeaways, topics, decisions, and action items.",
      schema: z.object({
        contactName: z.string().optional().describe("Name of contact to summarize chat with"),
        timeframeDays: z.number().optional().describe("Number of days back to look"),
        customFocus: z.string().optional().describe("Specific topic or question to focus summary on"),
      }),
    }
  );

  // -------------------------------------------------------------------
  // Tool 2: Extract Action Items & Tasks
  // -------------------------------------------------------------------
  const extractActionItems = tool(
    async ({ contactName }) => {
      try {
        let contactObjId = null;
        if (contactName) {
          contactObjId = await resolveContactId(contactName);
        }

        const messages = await retrieveRelevantMessages({
          userId,
          query: "action items tasks follow-up assignments promises deadlines due dates meeting schedules",
          limit: 30,
          contactId: contactObjId,
        });

        if (!messages || messages.length === 0) {
          return "No recent messages containing potential action items or tasks were found.";
        }

        const contextText = formatMessagesAsContext(messages);
        const model = getModel();

        const prompt = `You are an action-item extraction AI. Analyze these messages involving "${userName}" and identify concrete tasks, commitments, requests, or action items.

MESSAGES:
${contextText}

Return a JSON ARRAY of tasks ONLY inside a \`\`\`json block. Each task object MUST have:
- "title": concise task title
- "description": details or context from the chat
- "dueDate": deadline if mentioned or implied (e.g. "Tomorrow", "Next Monday"), or null
- "assignee": who is assigned or responsible (e.g. "${userName}" or contact name), or null
- "priority": "high", "medium", or "low"
- "sourceConversation": string describing sender/receiver involved (e.g. "Rahul")

If no clear tasks exist, return an empty array [].`;

        const res = await model.invoke(prompt);
        const rawText = typeof res.content === "string" ? res.content : JSON.stringify(res.content);

        let extractedTasks = [];
        const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i) || [null, rawText];
        try {
          extractedTasks = JSON.parse(jsonMatch[1].trim());
        } catch {
          extractedTasks = [];
        }

        const savedTasks = [];
        if (Array.isArray(extractedTasks) && extractedTasks.length > 0) {
          for (const item of extractedTasks) {
            if (!item.title) continue;
            const newTask = new Task({
              user: new mongoose.Types.ObjectId(userId),
              title: item.title,
              description: item.description || "",
              dueDate: item.dueDate || null,
              assignee: item.assignee || null,
              priority: ["high", "medium", "low"].includes(item.priority) ? item.priority : "medium",
              sourceConversation: item.sourceConversation || contactName || "Chat History",
            });
            await newTask.save();
            savedTasks.push(newTask);
          }
        }

        if (savedTasks.length === 0) {
          return "Analyzed recent chats: No new actionable tasks or commitments were detected.";
        }

        let summaryText = `Successfully extracted and saved ${savedTasks.length} action item(s) to your Task Manager:\n\n`;
        savedTasks.forEach((t, i) => {
          summaryText += `${i + 1}. **${t.title}** ${t.dueDate ? `(Due: ${t.dueDate})` : ""} [Priority: ${t.priority.toUpperCase()}]\n   *${t.description}*\n`;
        });

        return summaryText;
      } catch (err) {
        console.error("Error in extractActionItems tool:", err);
        return `Failed to extract action items: ${err.message}`;
      }
    },
    {
      name: "extract_action_items",
      description: "Extract action items, promises, assignments, and tasks from chat history and automatically save them to the user's task manager.",
      schema: z.object({
        contactName: z.string().optional().describe("Optional contact name to limit task extraction to"),
      }),
    }
  );

  // -------------------------------------------------------------------
  // Tool 3: Draft Reply Assistant
  // -------------------------------------------------------------------
  const draftReply = tool(
    async ({ contactName, topic, context }) => {
      try {
        let contactObjId = null;
        if (contactName) {
          contactObjId = await resolveContactId(contactName);
        }

        const recentMessages = await retrieveRelevantMessages({
          userId,
          query: topic || (contactName ? `messages with ${contactName}` : "recent conversation"),
          limit: 25,
          contactId: contactObjId,
        });

        // Also fetch user's past sent messages to analyze writing style
        const userSentMessages = await Message.find({
          senderId: new mongoose.Types.ObjectId(userId),
        })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean();

        const chatContextText = formatMessagesAsContext(recentMessages);
        const styleSampleText = userSentMessages.map((m) => `"${m.text}"`).join("\n");

        const model = getModel();
        const prompt = `You are a Smart Reply Assistant. You are drafting a response on behalf of "${userName}".

TARGET CONVERSATION CONTEXT:
${chatContextText || "No previous messages found."}

USER'S PAST WRITING STYLE SAMPLES:
${styleSampleText || "Friendly, polite, concise."}

USER'S DRAFT INSTRUCTION / INTENT:
${context || topic || "Draft a helpful response"}

TASK:
Write a natural, well-formatted draft reply that:
1. Matches "${userName}"'s tone, casing, punctuation style, and message length
2. Directly addresses the last message/question in the conversation context
3. Incorporates any user intent provided

OUTPUT ONLY THE DRAFT TEXT so it can be inserted directly into the user's chat message input box. Do not add quotes around the whole text or prefix with "Draft:".`;

        const res = await model.invoke(prompt);
        return typeof res.content === "string" ? res.content.trim() : JSON.stringify(res.content);
      } catch (err) {
        console.error("Error in draftReply tool:", err);
        return `Failed to draft reply: ${err.message}`;
      }
    },
    {
      name: "draft_reply",
      description: "Draft a reply message that matches the user's personal writing style based on conversation history.",
      schema: z.object({
        contactName: z.string().optional().describe("Name of the contact to draft a reply to"),
        topic: z.string().optional().describe("Topic or specific thing the reply should address"),
        context: z.string().optional().describe("Additional context about what the reply should say"),
      }),
    }
  );

  return [summarizeConversation, extractActionItems, draftReply];
}

/**
 * Runs the AI agent with the user's query.
 * The agent autonomously decides which tool(s) to invoke via model.bindTools.
 *
 * @param {string} userId - Authenticated user's ObjectId string
 * @param {string} userName - Authenticated user's display name
 * @param {string} query - User's natural-language request
 * @returns {Promise<object>} Agent result with action, toolUsed, and response
 */
export async function runAgent(userId, userName, query) {
  const model = getModel();
  const tools = createTools(userId, userName);
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const modelWithTools = model.bindTools(tools);

  const systemMessage = new SystemMessage(
    `You are SayHii AI Agent, an intelligent assistant embedded in the SayHii messaging app.
You help user "${userName}" with their chat conversations. You have 3 capabilities:
1. summarize_conversation: Summarize conversations or threads.
2. extract_action_items: Extract tasks/to-dos and automatically save them to the user's task manager.
3. draft_reply: Draft a reply matching the user's writing style.

Select and call the appropriate tool for the user's request.`
  );

  const messages = [systemMessage, new HumanMessage(query)];

  let response = await modelWithTools.invoke(messages);
  messages.push(response);

  let primaryToolUsed = null;

  if (response.tool_calls && response.tool_calls.length > 0) {
    for (const toolCall of response.tool_calls) {
      const selectedTool = toolsByName[toolCall.name];
      primaryToolUsed = toolCall.name;
      if (selectedTool) {
        const toolResultString = await selectedTool.invoke(toolCall.args);
        messages.push(
          new ToolMessage({
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: typeof toolResultString === "string" ? toolResultString : JSON.stringify(toolResultString),
          })
        );
      }
    }

    const finalResponse = await modelWithTools.invoke(messages);
    response = finalResponse;
  } else {
    // If no tool was invoked directly by LLM function call, fallback based on intent
    const lowerQ = query.toLowerCase();
    let fallbackToolName = "summarize_conversation";
    if (lowerQ.includes("task") || lowerQ.includes("todo") || lowerQ.includes("action item") || lowerQ.includes("assign")) {
      fallbackToolName = "extract_action_items";
    } else if (lowerQ.includes("draft") || lowerQ.includes("reply") || lowerQ.includes("respond") || lowerQ.includes("write")) {
      fallbackToolName = "draft_reply";
    }

    const fallbackTool = toolsByName[fallbackToolName];
    primaryToolUsed = fallbackToolName;
    if (fallbackTool) {
      const toolResultString = await fallbackTool.invoke({});
      messages.push(new HumanMessage(`Tool execution output:\n${toolResultString}`));
      const finalResponse = await modelWithTools.invoke(messages);
      response = finalResponse;
    }
  }

  const finalContent = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

  return {
    action: primaryToolUsed || "ai_agent",
    toolUsed: primaryToolUsed,
    response: finalContent,
  };
}
