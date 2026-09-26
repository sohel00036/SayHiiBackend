import express from "express";
import { protectRoute } from "../middleware/auth.middleware.js";
import {
  createGroup,
  getUserGroups,
  getPendingInvites,
  acceptInvite,
  declineInvite,
  getGroupMessages,
  sendGroupMessage,
} from "../controllers/group.controller.js";

const router = express.Router();

router.post("/create", protectRoute, createGroup);
router.get("/my-groups", protectRoute, getUserGroups);
router.get("/invites", protectRoute, getPendingInvites);
router.post("/invites/:inviteId/accept", protectRoute, acceptInvite);
router.post("/invites/:inviteId/decline", protectRoute, declineInvite);
router.get("/:groupId/messages", protectRoute, getGroupMessages);
router.post("/:groupId/send", protectRoute, sendGroupMessage);

export default router;
