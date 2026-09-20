import mongoose from "mongoose";
import User from "../models/user.model.js";
import Message from "../models/message.model.js";

import cloudinary from "../lib/cloudinary.js";
import { getReceiverSocketId, io } from "../lib/socket.js";
import { BOT_USER_ID } from "../lib/constants.js";
import { generateAIReplyStream, generateEmbedding } from "../lib/ai.service.js";

export const getUsersForSidebar = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;
    const loggedInObjId = new mongoose.Types.ObjectId(loggedInUserId);

    // 1. Fetch all users except logged-in user
    const users = await User.find({ _id: { $ne: loggedInUserId } }).select("-password").lean();

    // 2. Aggregate last message timestamp for each conversation involving loggedInUserId
    const lastMessages = await Message.aggregate([
      {
        $match: {
          $or: [{ senderId: loggedInObjId }, { receiverId: loggedInObjId }],
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$senderId", loggedInObjId] },
              "$receiverId",
              "$senderId",
            ],
          },
          lastMessageTime: { $first: "$createdAt" },
        },
      },
    ]);

    // Map lastMessages by contact userId string
    const lastMsgMap = {};
    lastMessages.forEach((item) => {
      if (item._id) {
        lastMsgMap[item._id.toString()] = item.lastMessageTime;
      }
    });

    // 3. Attach lastMessageTime to each user object
    const usersWithTimestamp = users.map((user) => ({
      ...user,
      lastMessageTime: lastMsgMap[user._id.toString()] || user.createdAt,
    }));

    // 4. Sort: Keep bot pinned at the top (isBot: true first), then human users sorted by lastMessageTime descending
    usersWithTimestamp.sort((a, b) => {
      if (a.isBot && !b.isBot) return -1;
      if (!a.isBot && b.isBot) return 1;

      const timeA = new Date(a.lastMessageTime || 0).getTime();
      const timeB = new Date(b.lastMessageTime || 0).getTime();
      return timeB - timeA;
    });

    res.status(200).json(usersWithTimestamp);
  } catch (error) {
    console.error("Error in getUsersForSidebar: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { id: userToChatId } = req.params;
    const myId = req.user._id;

    const myObjId = new mongoose.Types.ObjectId(myId);
    const userToChatObjId = new mongoose.Types.ObjectId(userToChatId);

    const messages = await Message.find({
      $or: [
        { senderId: myObjId, receiverId: userToChatObjId },
        { senderId: userToChatObjId, receiverId: myObjId },
      ],
    });

    res.status(200).json(messages);
  } catch (error) {
    console.log("Error in getMessages controller: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const { text, image } = req.body;
    const { id: receiverId } = req.params;
    const senderId = req.user._id;

    let imageUrl;
    if (image) {
      // Upload base64 image to cloudinary
      const uploadResponse = await cloudinary.uploader.upload(image);
      imageUrl = uploadResponse.secure_url;
    }

    const newMessage = new Message({
      senderId,
      receiverId,
      text,
      image: imageUrl,
    });

    await newMessage.save();

    const receiverSocketId = getReceiverSocketId(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json(newMessage);

    // Fire non-blocking embedding generation in background after response is sent
    if (text) {
      attachEmbeddingInBackground(newMessage._id, text);
    }

    // If message is sent to AI bot, generate AI reply asynchronously
    if (receiverId.toString() === BOT_USER_ID) {
      handleBotReply(senderId, text);
    }
  } catch (error) {
    console.log("Error in sendMessage controller: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Asynchronously generates and attaches vector embedding to a message in background.
 */
async function attachEmbeddingInBackground(messageId, text) {
  if (!text || !text.trim()) return;
  try {
    const embedding = await generateEmbedding(text);
    if (embedding) {
      await Message.findByIdAndUpdate(messageId, { embedding });
    }
  } catch (error) {
    console.error(`Failed to attach background embedding for message ${messageId}:`, error.message);
  }
}

/**
 * Handles async streaming AI response generation & socket events for SayHii AI bot.
 */
async function handleBotReply(userObjectId, userText) {
  const userIdStr = userObjectId.toString();
  const userSocketId = getReceiverSocketId(userIdStr);
  const tempMessageId = `temp-ai-${Date.now()}`;

  try {
    // 1. Fetch last 10 messages between user and bot for context
    const recentMessages = await Message.find({
      $or: [
        { senderId: userObjectId, receiverId: BOT_USER_ID },
        { senderId: BOT_USER_ID, receiverId: userObjectId },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(10);

    // Sort chronologically
    recentMessages.reverse();

    // 2. Stream tokens from Gemini API
    const fullReplyText = await generateAIReplyStream(
      recentMessages,
      userText,
      BOT_USER_ID,
      (chunkText, fullTextSoFar) => {
        if (userSocketId) {
          io.to(userSocketId).emit("aiMessageChunk", {
            tempMessageId,
            senderId: BOT_USER_ID,
            receiverId: userIdStr,
            chunkText,
            fullText: fullTextSoFar,
          });
        }
      }
    );

    // 3. Save AI reply to database
    const aiMessage = new Message({
      senderId: BOT_USER_ID,
      receiverId: userObjectId,
      text: fullReplyText,
    });
    await aiMessage.save();

    // Attach embedding in background for AI reply
    attachEmbeddingInBackground(aiMessage._id, fullReplyText);

    // 4. Emit completion event via aiMessageDone (replaces streaming temp placeholder)
    if (userSocketId) {
      io.to(userSocketId).emit("aiMessageDone", {
        tempMessageId,
        message: aiMessage,
      });
    }
  } catch (error) {
    console.error("Error in handleBotReply:", error.message);

    // Fallback response handling so UI does not hang
    const fallbackText = "Sorry, I'm having trouble responding right now.";
    const fallbackMessage = new Message({
      senderId: BOT_USER_ID,
      receiverId: userObjectId,
      text: fallbackText,
    });
    await fallbackMessage.save();

    if (userSocketId) {
      io.to(userSocketId).emit("aiMessageDone", {
        tempMessageId,
        message: fallbackMessage,
      });
    }
  }
}
