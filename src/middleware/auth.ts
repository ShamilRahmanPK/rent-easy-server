import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { readSessionToken } from "../lib/session.js";

export interface AuthUser {
  id: string;
  userNumber: number;
  email: string;
  fullName: string;
  roles: Role[];
  emailVerified: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const STAFF_ROLES: Role[] = ["admin", "super_admin"];

export const hasRole = (user: Pick<AuthUser, "roles">, role: Role) => user.roles.includes(role);
export const hasAnyRole = (user: Pick<AuthUser, "roles">, roles: Role[]) => roles.some((role) => user.roles.includes(role));
export const isStaff = (user: Pick<AuthUser, "roles">) => hasAnyRole(user, STAFF_ROLES);
export const isSuperAdmin = (user: Pick<AuthUser, "roles">) => hasRole(user, "super_admin");

// Returns the signed-in user. Only call inside handlers behind requireAuth.
export function currentUser(request: Request): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  const token = request.cookies?.token || request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw unauthorized("Not authenticated");

  const session = readSessionToken(token);
  if (!session) throw unauthorized("Invalid or expired session");

  // Roles and status are read from the database on every request, so a role change
  // or suspension takes effect immediately instead of when the token expires.
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: {
      id: true,
      userNumber: true,
      email: true,
      fullName: true,
      emailVerified: true,
      status: true,
      tokenVersion: true,
      roles: { select: { role: true } },
    },
  });

  if (!user || user.tokenVersion !== session.tv) throw unauthorized("Invalid or expired session");
  if (user.status !== "Active") throw forbidden(`Account is ${user.status.toLowerCase()}`);

  request.user = {
    id: user.id,
    userNumber: user.userNumber,
    email: user.email,
    fullName: user.fullName,
    emailVerified: user.emailVerified,
    roles: user.roles.map((entry) => entry.role),
  };
  next();
}

export function requireRole(...allowedRoles: Role[]) {
  return (request: Request, _response: Response, next: NextFunction) => {
    const user = currentUser(request);
    if (!hasAnyRole(user, allowedRoles)) throw forbidden();
    next();
  };
}

export const requireStaff = requireRole(...STAFF_ROLES);
export const requireSuperAdmin = requireRole("super_admin");

export function requireVerifiedEmail(request: Request, _response: Response, next: NextFunction) {
  if (!currentUser(request).emailVerified) {
    throw forbidden("Verify your email address first");
  }
  next();
}
