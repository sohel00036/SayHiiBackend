import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: "",
    },
    dueDate: {
      type: String,
      default: null,
    },
    assignee: {
      type: String,
      default: null,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    completed: {
      type: Boolean,
      default: false,
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    sourceConversation: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Keep completed and isCompleted in sync
taskSchema.pre("save", function (next) {
  if (this.isModified("completed") && !this.isModified("isCompleted")) {
    this.isCompleted = this.completed;
  } else if (this.isModified("isCompleted") && !this.isModified("completed")) {
    this.completed = this.isCompleted;
  }
  next();
});

const Task = mongoose.model("Task", taskSchema);

export default Task;
