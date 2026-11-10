import type { Property } from "@prisma/client";
import { notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { isStaff, type AuthUser } from "../middleware/auth.js";

export const MIN_PROPERTY_PHOTOS = 3;
export const MAX_PROPERTY_PHOTOS = 20;
export const MAX_UNIT_PHOTOS = 15;
export const MAX_OWNERSHIP_DOCUMENTS = 5;

// Staff can manage every property; owners only their own. Anyone else gets "not found" so ids cannot be probed.
export async function loadManageableProperty(user: AuthUser, propertyId: string): Promise<Property> {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property || (!isStaff(user) && property.ownerId !== user.id)) throw notFound("Property not found");
  return property;
}

export async function loadManageableUnit(user: AuthUser, unitId: string) {
  const unit = await prisma.unit.findUnique({ where: { id: unitId }, include: { property: true } });
  if (!unit || (!isStaff(user) && unit.property.ownerId !== user.id)) throw notFound("Unit not found");
  return unit;
}
