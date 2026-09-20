import mongoose from "mongoose";
import Message from "../models/message.model.js";
import { generateEmbedding, generateRAGAnswer } from "../lib/ai.service.js";

/**
 * Controller to answer natural-language questions about user's past chats using Vector RAG Search.
 */
export const askAIAboutChats = async (req, res) => {
  try {
    const { query } = req.body;
    const userId = req.user._id;

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ message: "Search query is required." });
    }

    // 1. Generate query embedding (768 dimensions)
    const queryVector = await generateEmbedding(query);

    let matchingMessages = [];

    // 2. Perform MongoDB Atlas $vectorSearch if vector exists
    if (queryVector && queryVector.length > 0) {
      try {
        const pipeline = [
          {
            $vectorSearch: {
              index: "vector_index",
              path: "embedding",
              queryVector,
              numCandidates: 100,
              limit: 8,
              filter: {
                $or: [
                  { senderId: new mongoose.Types.ObjectId(userId) },
                  { receiverId: new mongoose.Types.ObjectId(userId) },
                ],
              },
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "senderId",
              foreignField: "_id",
              as: "sender",
            },
          },
          {
            $unwind: { path: "$sender", preserveNullAndEmptyArrays: true },
          },
          {
            $lookup: {
              from: "users",
              localField: "receiverId",
              foreignField: "_id",
              as: "receiver",
            },
          },
          {
            $unwind: { path: "$receiver", preserveNullAndEmptyArrays: true },
          },
          {
            $project: {
              _id: 1,
              text: 1,
              senderId: 1,
              receiverId: 1,
              createdAt: 1,
              "sender.fullName": 1,
              "sender.profilePic": 1,
              "receiver.fullName": 1,
            },
          },
        ];

        matchingMessages = await Message.aggregate(pipeline);
      } catch (vectorSearchError) {
        console.warn("Atlas vector search notice (index might be building):", vectorSearchError.message);
      }
    }

    // Fallback: If vector search returns 0 results or index is building, retrieve recent user messages
    if (!matchingMessages || matchingMessages.length === 0) {
      const userObjId = new mongoose.Types.ObjectId(userId);
      matchingMessages = await Message.aggregate([
        {
          $match: {
            $or: [{ senderId: userObjId }, { receiverId: userObjId }],
            text: { $exists: true, $ne: "" },
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: 15 },
        {
          $lookup: {
            from: "users",
            localField: "senderId",
            foreignField: "_id",
            as: "sender",
          },
        },
        { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "users",
            localField: "receiverId",
            foreignField: "_id",
            as: "receiver",
          },
        },
        { $unwind: { path: "$receiver", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            text: 1,
            senderId: 1,
            receiverId: 1,
            createdAt: 1,
            "sender.fullName": 1,
            "sender.profilePic": 1,
            "receiver.fullName": 1,
          },
        },
      ]);
    }

    // 3. Generate grounded answer using Gemini LLM
    const answer = await generateRAGAnswer(query, matchingMessages);

    // 4. Format source citations for response
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
