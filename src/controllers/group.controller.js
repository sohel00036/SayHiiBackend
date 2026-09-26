import mongoose from "mongoose";
import Group from "../models/group.model.js";
import GroupInvite from "../models/groupInvite.model.js";
import Message from "../models/message.model.js";
import User from "../models/user.model.js";
import cloudinary from "../lib/cloudinary.js";
import { getReceiverSocketId, io } from "../lib/socket.js";
import { generateEmbedding } from "../lib/ai.service.js";

/**
 * Creates a new group, adds the creator as admin & active member,
 * adds selected members to pendingMembers, and dispatches real-time invitations.
 */
export const createGroup = async (req, res) => {
  try {
    const { name, description, memberIds } = req.body;
    const creatorId = req.user._id;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Group name is required." });
    }

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ message: "Please select at least one member to invite." });
    }

    // Filter out creator from invited member list if included
    const validInvitedIds = memberIds
      .map((id) => id.toString())
      .filter((id) => id !== creatorId.toString());

    if (validInvitedIds.length === 0) {
      return res.status(400).json({ message: "Please invite other users to form a group." });
    }

    // Create the group
    const newGroup = new Group({
      name: name.trim(),
      description: (description || "").trim(),
      creator: creatorId,
      admins: [creatorId],
      members: [creatorId], // Only creator is member until invited users accept
      pendingMembers: validInvitedIds.map((id) => new mongoose.Types.ObjectId(id)),
      lastMessage: {
        text: `Group "${name.trim()}" created by ${req.user.fullName}`,
        sender: creatorId,
        createdAt: new Date(),
      },
    });

    await newGroup.save();

    // Create invitation records and dispatch socket notifications
    const invitePromises = validInvitedIds.map(async (invitedId) => {
      const invite = new GroupInvite({
        group: newGroup._id,
        invitedUser: new mongoose.Types.ObjectId(invitedId),
        invitedBy: creatorId,
        status: "pending",
      });
      await invite.save();

      // Real-time socket notification to the invited user
      const receiverSocketId = getReceiverSocketId(invitedId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("groupInvitation", {
          inviteId: invite._id,
          group: {
            _id: newGroup._id,
            name: newGroup.name,
            description: newGroup.description,
            creator: {
              _id: req.user._id,
              fullName: req.user.fullName,
              profilePic: req.user.profilePic,
            },
          },
          invitedBy: {
            _id: req.user._id,
            fullName: req.user.fullName,
            profilePic: req.user.profilePic,
          },
          createdAt: invite.createdAt,
        });
      }

      return invite;
    });

    await Promise.all(invitePromises);

    const populatedGroup = await Group.findById(newGroup._id)
      .populate("members", "fullName profilePic email")
      .populate("admins", "fullName profilePic email")
      .populate("creator", "fullName profilePic email");

    return res.status(201).json(populatedGroup);
  } catch (error) {
    console.error("Error in createGroup controller:", error);
    return res.status(500).json({ message: "Failed to create group." });
  }
};

/**
 * Returns all groups where the authenticated user is an active member.
 */
export const getUserGroups = async (req, res) => {
  try {
    const userId = req.user._id;

    const groups = await Group.find({ members: userId })
      .populate("members", "fullName profilePic email")
      .populate("admins", "fullName profilePic email")
      .populate("creator", "fullName profilePic email")
      .populate("lastMessage.sender", "fullName profilePic")
      .sort({ updatedAt: -1 });

    return res.status(200).json(groups);
  } catch (error) {
    console.error("Error in getUserGroups controller:", error);
    return res.status(500).json({ message: "Failed to fetch groups." });
  }
};

/**
 * Returns all pending group invitations for the authenticated user.
 */
export const getPendingInvites = async (req, res) => {
  try {
    const userId = req.user._id;

    const invites = await GroupInvite.find({
      invitedUser: userId,
      status: "pending",
    })
      .populate({
        path: "group",
        select: "name description groupPic members creator",
        populate: { path: "creator", select: "fullName profilePic email" },
      })
      .populate("invitedBy", "fullName profilePic email")
      .sort({ createdAt: -1 });

    return res.status(200).json(invites);
  } catch (error) {
    console.error("Error in getPendingInvites controller:", error);
    return res.status(500).json({ message: "Failed to fetch group invitations." });
  }
};

/**
 * Accept a group invitation. Adds user to group members and removes from pending.
 */
export const acceptInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const userId = req.user._id;

    const invite = await GroupInvite.findOne({
      _id: inviteId,
      invitedUser: userId,
      status: "pending",
    });

    if (!invite) {
      return res.status(404).json({ message: "Invitation not found or already processed." });
    }

    invite.status = "accepted";
    await invite.save();

    const group = await Group.findByIdAndUpdate(
      invite.group,
      {
        $addToSet: { members: userId },
        $pull: { pendingMembers: userId },
      },
      { new: true }
    )
      .populate("members", "fullName profilePic email")
      .populate("admins", "fullName profilePic email")
      .populate("creator", "fullName profilePic email");

    if (!group) {
      return res.status(404).json({ message: "Group not found." });
    }

    // System welcome message in the group
    const systemMessage = new Message({
      senderId: userId,
      groupId: group._id,
      text: `${req.user.fullName} joined the group 🎉`,
    });
    await systemMessage.save();

    // Notify all active group members via socket
    group.members.forEach((member) => {
      const memberSocketId = getReceiverSocketId(member._id.toString());
      if (memberSocketId) {
        io.to(memberSocketId).emit("groupMemberJoined", {
          groupId: group._id,
          user: {
            _id: req.user._id,
            fullName: req.user.fullName,
            profilePic: req.user.profilePic,
          },
          systemMessage,
        });
      }
    });

    return res.status(200).json({ message: "Joined group successfully!", group });
  } catch (error) {
    console.error("Error in acceptInvite controller:", error);
    return res.status(500).json({ message: "Failed to accept invitation." });
  }
};

/**
 * Decline a group invitation.
 */
export const declineInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const userId = req.user._id;

    const invite = await GroupInvite.findOne({
      _id: inviteId,
      invitedUser: userId,
      status: "pending",
    });

    if (!invite) {
      return res.status(404).json({ message: "Invitation not found or already processed." });
    }

    invite.status = "declined";
    await invite.save();

    await Group.findByIdAndUpdate(invite.group, {
      $pull: { pendingMembers: userId },
    });

    return res.status(200).json({ message: "Invitation declined." });
  } catch (error) {
    console.error("Error in declineInvite controller:", error);
    return res.status(500).json({ message: "Failed to decline invitation." });
  }
};

/**
 * Fetches all messages for a specific group.
 */
export const getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ message: "Group not found." });
    }

    const isMember = group.members.some((m) => m.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ message: "You are not a member of this group." });
    }

    const messages = await Message.find({ groupId })
      .populate("senderId", "fullName profilePic email")
      .sort({ createdAt: 1 });

    return res.status(200).json(messages);
  } catch (error) {
    console.error("Error in getGroupMessages controller:", error);
    return res.status(500).json({ message: "Failed to fetch group messages." });
  }
};

/**
 * Sends a message to a group. Broadcasts real-time to all group members.
 */
export const sendGroupMessage = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { text, image } = req.body;
    const senderId = req.user._id;

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ message: "Group not found." });
    }

    const isMember = group.members.some((m) => m.toString() === senderId.toString());
    if (!isMember) {
      return res.status(403).json({ message: "You are not a member of this group." });
    }

    if (!text && !image) {
      return res.status(400).json({ message: "Message text or image is required." });
    }

    let imageUrl = null;
    if (image) {
      const uploadResponse = await cloudinary.uploader.upload(image);
      imageUrl = uploadResponse.secure_url;
    }

    const newMessage = new Message({
      senderId,
      groupId,
      text: text ? text.trim() : "",
      image: imageUrl,
    });

    await newMessage.save();

    // Populate sender info for frontend rendering
    const populatedMessage = await Message.findById(newMessage._id).populate(
      "senderId",
      "fullName profilePic email"
    );

    // Update lastMessage on group
    group.lastMessage = {
      text: text ? text.trim() : "Photo attachment",
      sender: senderId,
      createdAt: newMessage.createdAt,
    };
    await group.save();

    // Broadcast message to all active members of the group
    group.members.forEach((memberId) => {
      const memberSocketId = getReceiverSocketId(memberId.toString());
      if (memberSocketId) {
        io.to(memberSocketId).emit("newGroupMessage", {
          groupId,
          message: populatedMessage,
        });
      }
    });

    // Generate vector embedding in background for AI RAG search
    if (newMessage.text) {
      generateEmbedding(newMessage.text)
        .then((embedding) => {
          if (embedding && embedding.length > 0) {
            Message.updateOne({ _id: newMessage._id }, { embedding }).exec();
          }
        })
        .catch((err) => {
          console.warn("Background group message embedding generation failed:", err.message);
        });
    }

    return res.status(201).json(populatedMessage);
  } catch (error) {
    console.error("Error in sendGroupMessage controller:", error);
    return res.status(500).json({ message: "Failed to send group message." });
  }
};
