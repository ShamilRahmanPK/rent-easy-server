import type { Prisma, Role } from "@prisma/client";
import { formatUserCode } from "./formatCode.js";

export const userInclude = { roles: { select: { role: true } } } satisfies Prisma.UserInclude;
export type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

const ROLE_ORDER: Role[] = ["super_admin", "admin", "owner", "tenant", "user"];

export const sortRoles = (roles: Role[]) => [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));

// ID number and ID document are shown only to the person and to admins.
export function serializeUser(user: UserWithRoles, options: { includeIdentity?: boolean } = {}) {
  const base = {
    id: user.id,
    userId: formatUserCode(user.userNumber),
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    roles: sortRoles(user.roles.map((entry) => entry.role)),
    emailVerified: user.emailVerified,
    status: user.status,
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
    address: user.address,
    city: user.city,
    country: user.country,
    notifications: { inApp: user.notifyInApp, emailUpdates: user.notifyEmailUpdates },
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  if (!options.includeIdentity) return base;
  return {
    ...base,
    idType: user.idType,
    idNumber: user.idNumber,
    idDocumentFileId: user.idDocumentFileId,
  };
}

export const money = (value: Prisma.Decimal | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);
