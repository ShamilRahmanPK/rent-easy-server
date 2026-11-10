import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";

const base = { standardHeaders: "draft-8" as const, legacyHeaders: false };

export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

export const publicLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: env.PUBLIC_RATE_LIMIT,
  message: { error: "Too many requests. Slow down." },
});

export const uploadLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: env.UPLOAD_RATE_LIMIT,
  message: { error: "Too many uploads. Slow down." },
});
