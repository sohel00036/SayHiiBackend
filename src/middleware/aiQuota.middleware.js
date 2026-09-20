import User from "../models/user.model.js";

const DEFAULT_ADMIN_EMAILS = ["monica@gmail.com", "ross@gmail.com"];

/**
 * Checks and increments the daily AI usage quota for a user.
 * Admin users (monica@gmail.com, ross@gmail.com, or specified in process.env.ADMIN_EMAILS) get UNLIMITED access.
 * Non-admin users are restricted to AI_DAILY_LIMIT (default: 5) queries per calendar day.
 */
export const checkAndIncrementAiQuota = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return { allowed: false, message: "User not found." };
    }

    // Determine admin emails (defaults + env overrides)
    const envAdminEmails = process.env.ADMIN_EMAILS
      ? process.env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase())
      : [];
    const adminEmails = [...DEFAULT_ADMIN_EMAILS, ...envAdminEmails];

    // Check if user is Admin / Owner
    if (user.email && adminEmails.includes(user.email.toLowerCase())) {
      return { allowed: true, remaining: Infinity, isUnlimited: true };
    }

    const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const dailyLimit = parseInt(process.env.AI_DAILY_LIMIT || "5", 10);

    // Reset quota if calendar day changed
    if (user.lastAiQueryDate !== todayStr) {
      user.aiQueryCount = 0;
      user.lastAiQueryDate = todayStr;
    }

    // Check if limit reached
    if (user.aiQueryCount >= dailyLimit) {
      await user.save();
      return {
        allowed: false,
        count: user.aiQueryCount,
        limit: dailyLimit,
        message: `Daily AI demo limit reached (${dailyLimit}/${dailyLimit} queries used today). Please try again tomorrow!`,
      };
    }

    // Increment count for non-admin user
    user.aiQueryCount += 1;
    await user.save();

    return {
      allowed: true,
      count: user.aiQueryCount,
      limit: dailyLimit,
      remaining: dailyLimit - user.aiQueryCount,
    };
  } catch (error) {
    console.error("Error in checkAndIncrementAiQuota:", error.message);
    // On unexpected error, allow request so app doesn't break
    return { allowed: true };
  }
};
