import { GoogleGenAI } from "@google/genai";

/**
 * Dedicated AI Service Module for SayHii.
 * Handles interaction with Google Gemini API.
 * Phase 1: Direct Gemini reply & token streaming.
 * Phase 2: Gemini Embeddings (gemini-embedding-001, 768 dim) & RAG search answer generation.
 * Phase 3: Can be extended with summarization and action item extraction.
 */

const BOT_SYSTEM_INSTRUCTION = `You are SayHii AI, a friendly, helpful, and concise AI assistant embedded inside the SayHii real-time messaging application. 
Respond in clear, conversational markdown. Keep replies helpful and well-formatted.`;

/**
 * Helper to get initialized GoogleGenAI client instance
 */
function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing from environment variables.");
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Formats database conversation history into Gemini API contents structure.
 */
export function formatConversationForGemini(conversationHistory = [], newUserMessage = "", botUserId = "") {
  const contents = [];

  for (const msg of conversationHistory) {
    if (!msg.text) continue;
    const isBot = msg.senderId.toString() === botUserId.toString();
    contents.push({
      role: isBot ? "model" : "user",
      parts: [{ text: msg.text }],
    });
  }

  if (newUserMessage) {
    contents.push({
      role: "user",
      parts: [{ text: newUserMessage }],
    });
  }

  return contents;
}

/**
 * Generates a full AI reply string from Gemini API.
 */
export async function generateAIReply(conversationHistory = [], newUserMessage = "", botUserId = "") {
  try {
    const ai = getAIClient();
    const contents = formatConversationForGemini(conversationHistory, newUserMessage, botUserId);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: BOT_SYSTEM_INSTRUCTION,
      },
    });

    return response.text || "I'm sorry, I couldn't process your request.";
  } catch (error) {
    console.error("Error in generateAIReply:", error.message);
    throw error;
  }
}

/**
 * Generates a streaming AI reply from Gemini API.
 */
export async function generateAIReplyStream(conversationHistory = [], newUserMessage = "", botUserId = "", onChunk = null) {
  try {
    const ai = getAIClient();
    const contents = formatConversationForGemini(conversationHistory, newUserMessage, botUserId);

    const responseStream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: BOT_SYSTEM_INSTRUCTION,
      },
    });

    let fullReplyText = "";
    for await (const chunk of responseStream) {
      const chunkText = chunk.text || "";
      fullReplyText += chunkText;
      if (onChunk && chunkText) {
        onChunk(chunkText, fullReplyText);
      }
    }

    return fullReplyText || "I'm sorry, I couldn't process your request.";
  } catch (error) {
    console.error("Error in generateAIReplyStream:", error.message);
    throw error;
  }
}

/**
 * Generates vector embeddings for a given text string using Gemini gemini-embedding-001 (768 dimensions).
 * @param {string} text - Message or query text to embed
 * @returns {Promise<number[]>} Array of 768 floating point numbers
 */
export async function generateEmbedding(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return null;
  }
  try {
    const ai = getAIClient();
    const response = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
      config: {
        outputDimensionality: 768,
      },
    });
    return response.embeddings?.[0]?.values || response.embedding?.values || null;
  } catch (error) {
    console.error("Error in generateEmbedding:", error.message);
    throw error;
  }
}

/**
 * Generates a grounded RAG answer based strictly on retrieved chat history context.
 * @param {string} query - User's search question
 * @param {Array} matchingMessages - List of retrieved source messages
 * @returns {Promise<string>} Grounded answer
 */
export async function generateRAGAnswer(query, matchingMessages = []) {
  try {
    const ai = getAIClient();

    const contextText = matchingMessages
      .map((msg, idx) => {
        const sender = msg.sender?.fullName || "User";
        const receiver = msg.receiver?.fullName || "User";
        const dateStr = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "Unknown date";
        return `[Message ${idx + 1}] (${dateStr}) ${sender} to ${receiver}: "${msg.text}"`;
      })
      .join("\n");

    const prompt = `You are SayHii Chat Assistant. Answer the user's question ONLY based on the past chat context provided below. 
If the information needed to answer the question is not present in the chat messages, explicitly state: "I couldn't find any relevant information in your chat history to answer this question."

Chat Context:
${contextText || "No matching chat messages found."}

User Question: ${query}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    return response.text || "I couldn't find any relevant information in your chat history to answer this question.";
  } catch (error) {
    console.error("Error in generateRAGAnswer:", error.message);
    throw error;
  }
}
