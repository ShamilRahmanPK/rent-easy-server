import type { Prisma, Role } from "@prisma/client";
import { unprocessable } from "../lib/errors.js";
import { ageInYears } from "../lib/validation.js";

type Tx = Prisma.TransactionClient;

export async function grantRole(tx: Tx, userId: string, role: Role): Promise<boolean> {
  const existing = await tx.userRole.findUnique({ where: { userId_role: { userId, role } } });
  if (existing) return false;
  await tx.userRole.create({ data: { userId, role } });
  return true;
}

export async function revokeRole(tx: Tx, userId: string, role: Role): Promise<boolean> {
  const result = await tx.userRole.deleteMany({ where: { userId, role } });
  return result.count > 0;
}

interface IdentityFields {
  idType: string | null;
  idNumber: string | null;
  idDocumentFileId: string | null;
  dateOfBirth: Date | null;
}

// Owners and tenants must have an ID on file, and be 18 or older if a birth date is given.
export function assertIdentityComplete(user: IdentityFields, who = "Your"): void {
  const missing: string[] = [];
  if (!user.idType) missing.push("idType");
  if (!user.idNumber) missing.push("idNumber");
  if (!user.idDocumentFileId) missing.push("idDocument");
  if (missing.length > 0) {
    throw unprocessable(`${who} identity details are incomplete. Add the ID type, ID number and ID document in the profile.`, { missing });
  }
  if (user.dateOfBirth && ageInYears(user.dateOfBirth) < 18) {
    throw unprocessable("Owners and tenants must be 18 or older");
  }
}
