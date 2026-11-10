import type { Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface SessionPayload {
  id: string;
  tv: number;
}

export function createSessionToken(user: { id: string; tokenVersion: number }): string {
  return jwt.sign({ id: user.id, tv: user.tokenVersion } satisfies SessionPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function readSessionToken(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as Partial<SessionPayload>;
    if (typeof decoded.id !== "string" || typeof decoded.tv !== "number") return null;
    return { id: decoded.id, tv: decoded.tv };
  } catch {
    return null;
  }
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie("token", { httpOnly: true, sameSite: "lax", secure: env.isProduction });
}
