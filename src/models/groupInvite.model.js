import mongoose from "mongoose";

const groupInviteSchema = new mongoose.Schema(
  {
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: true,
    },
    invitedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "pending",
    },
  },
  { timestamps: true }
);

// Prevent duplicate invitations for the same user and group
groupInviteSchema.index({ group: 1, invitedUser: 1 }, { unique: true });

const GroupInvite = mongoose.model("GroupInvite", groupInviteSchema);

export default GroupInvite;
