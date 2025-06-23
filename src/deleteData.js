import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import User from "./models/user.model.js";
import Message from "./models/message.model.js";

// Enable __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI ;
    await mongoose.connect(mongoUri);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
};

const deleteData = async () => {
  try {
    console.log("inside delete data...");
    await connectDB();

    await User.deleteMany({});
    await Message.deleteMany({});

    console.log("All data deleted from User and Message collections.");
    process.exit();
  } catch (err) {
    console.log("hello")
    console.error("Error deleting data:", err);
    process.exit(1);
  }
};

deleteData();
