import { config } from "dotenv";
import { connectDB } from "../lib/db.js";
import Message from "../models/message.model.js";
import { generateEmbedding } from "../lib/ai.service.js";

config();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function backfillEmbeddings() {
  try {
    await connectDB();
    console.log("Connected to MongoDB for embedding backfill...");

    const messagesWithoutEmbedding = await Message.find({
      text: { $exists: true, $ne: "" },
      $or: [{ embedding: { $exists: false } }, { embedding: null }, { embedding: { $size: 0 } }],
    }).select("+embedding");

    console.log(`Found ${messagesWithoutEmbedding.length} messages requiring embeddings.`);

    let count = 0;
    for (const msg of messagesWithoutEmbedding) {
      if (!msg.text || !msg.text.trim()) continue;

      try {
        const embedding = await generateEmbedding(msg.text);
        if (embedding && embedding.length > 0) {
          await Message.findByIdAndUpdate(msg._id, { embedding });
          count++;
          console.log(`[${count}/${messagesWithoutEmbedding.length}] Attached ${embedding.length}-dim embedding to message ID: ${msg._id}`);
        } else {
          console.log(`Embedding returned empty/null for message ${msg._id}`);
        }
      } catch (err) {
        console.error(`Error embedding message ${msg._id}:`, err);
      }

      await delay(200);
    }

    console.log(`Successfully backfilled embeddings for ${count} messages.`);
    process.exit(0);
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
}

backfillEmbeddings();
