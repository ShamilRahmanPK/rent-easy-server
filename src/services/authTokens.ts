import type { AuthTokenType } from "@prisma/client";
import { randomToken, sha256 } from "../lib/crypto.js";
import { badRequest, tooManyRequests } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

const HOUR_MS = 60 * 60 * 1000;
export const TOKEN_LIFETIME = {
  email_verify: 24 * HOUR_MS,
  password_reset: HOUR_MS,
  staff_invite: 72 * HOUR_MS,
} as const;

// At most 3 verification or reset emails per person per hour.
export async function assertTokenRateLimit(userId: string, type: AuthTokenType): Promise<void> {
  const recent = await prisma.authToken.count({
    where: { userId, type, createdAt: { gte: new Date(Date.now() - HOUR_MS) } },
  });
  if (recent >= 3) throw tooManyRequests("Too many emails requested. Try again in an hour.");
}

// Only the hash is stored, so a database leak does not expose working links.
export async function createAuthToken(userId: string, type: AuthTokenType, lifetimeMs: number): Promise<string> {
  const token = randomToken(32);
  await prisma.authToken.create({
    data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + lifetimeMs) },
  });
  return token;
}

// Marks the token as used in one atomic step, so a link works exactly once even under a race.
export async function consumeAuthToken(token: string, type: AuthTokenType): Promise<string> {
  const record = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.type !== type) throw badRequest("This link is invalid or has expired");

  const claimed = await prisma.authToken.updateMany({
    where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) throw badRequest("This link is invalid or has expired");
  return record.userId;
}

export async function invalidateTokens(userId: string, type: AuthTokenType): Promise<void> {
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
}
