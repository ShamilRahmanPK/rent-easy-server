import { Prisma } from "@prisma/client";
import { conflict, notFound } from "../lib/errors.js";
import { formatUnitCode } from "../lib/formatCode.js";
import { prisma } from "../lib/prisma.js";
import { assertIdentityComplete, grantRole, revokeRole } from "./accounts.js";
import { notifyUser } from "./notifications.js";

interface CreateTenancyInput {
  unitId: string;
  tenantId: string;
  startDate: Date;
  createdById: string;
  approvedRequestId?: string;
}

const unitLabel = (unit: { unitNumber: string; unitSerial: number }) => `${unit.unitNumber} (${formatUnitCode(unit.unitSerial)})`;

// Links a tenant to a vacant unit. Used by both "admin links a tenant" and "admin approves a rent request".
export async function createTenancy(input: CreateTenancyInput) {
  const unit = await prisma.unit.findUnique({ where: { id: input.unitId }, include: { property: true } });
  if (!unit) throw notFound("Unit not found");
  if (unit.property.approvalStatus !== "Approved" || unit.property.listingStatus === "Archived") {
    throw conflict("The property is not approved or is archived");
  }
  if (unit.status !== "Vacant") throw conflict(`The unit is ${unit.status === "Occupied" ? "already occupied" : "under maintenance"}`);

  const tenant = await prisma.user.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw notFound("Tenant not found");
  if (tenant.status !== "Active") throw conflict("The tenant's account is not active");
  if (!tenant.emailVerified) throw conflict("The tenant has not verified their email");
  assertIdentityComplete(tenant, "The tenant's");

  let roleAdded = false;
  let tenancy;
  try {
    tenancy = await prisma.$transaction(async (tx) => {
      // The unique index on active tenancies per unit makes a double booking impossible, even in a race.
      const created = await tx.tenancy.create({
        data: { unitId: unit.id, tenantId: tenant.id, startDate: input.startDate, createdById: input.createdById },
      });
      await tx.unit.update({ where: { id: unit.id }, data: { status: "Occupied" } });
      roleAdded = await grantRole(tx, tenant.id, "tenant");
      await tx.rentRequest.updateMany({
        where: { unitId: unit.id, status: "Pending", ...(input.approvedRequestId ? { id: { not: input.approvedRequestId } } : {}) },
        data: { status: "Cancelled", decisionNote: "The unit was rented to someone else", decidedAt: new Date(), decidedById: input.createdById },
      });
      return created;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("The unit already has an active tenancy");
    throw error;
  }

  const variables = {
    unitName: unitLabel(unit),
    propertyName: unit.property.name,
    startDate: input.startDate.toISOString().slice(0, 10),
  };
  await notifyUser({
    userId: tenant.id,
    type: "tenancy.started",
    title: "You are now a tenant",
    message: `You are linked to unit ${variables.unitName} at ${variables.propertyName}.`,
    link: "/my-tenancy",
    email: { template: "unit_assigned", variables },
  });
  if (roleAdded) {
    await notifyUser({ userId: tenant.id, type: "account.role_changed", title: "Your roles changed", message: "The tenant role was added to your account." });
  }
  await notifyUser({
    userId: unit.property.ownerId,
    type: "tenancy.started",
    title: "A tenant was linked to your unit",
    message: `${tenant.fullName} is now the tenant of ${variables.unitName} at ${variables.propertyName}.`,
    link: `/properties/${unit.property.id}`,
    email: { template: "tenant_linked_owner", variables: { ...variables, tenantName: tenant.fullName } },
  });

  return tenancy;
}

export async function endTenancy(tenancyId: string, endDate: Date) {
  const tenancy = await prisma.tenancy.findUnique({ where: { id: tenancyId }, include: { unit: { include: { property: true } }, tenant: true } });
  if (!tenancy) throw notFound("Tenancy not found");
  if (tenancy.status !== "Active") throw conflict("This tenancy has already ended");
  if (endDate < tenancy.startDate) throw conflict("The end date cannot be before the start date");

  const roleRemoved = await prisma.$transaction(async (tx) => {
    await tx.tenancy.update({ where: { id: tenancy.id }, data: { status: "Ended", endDate } });
    await tx.unit.update({ where: { id: tenancy.unitId }, data: { status: "Vacant" } });
    const otherActive = await tx.tenancy.count({ where: { tenantId: tenancy.tenantId, status: "Active", id: { not: tenancy.id } } });
    return otherActive === 0 ? revokeRole(tx, tenancy.tenantId, "tenant") : false;
  });

  const variables = { unitName: unitLabel(tenancy.unit), propertyName: tenancy.unit.property.name };
  await notifyUser({
    userId: tenancy.tenantId,
    type: "tenancy.ended",
    title: "Your tenancy has ended",
    message: `Your tenancy of ${variables.unitName} at ${variables.propertyName} has ended.`,
    email: { template: "tenancy_ended", variables },
  });
  if (roleRemoved) {
    await notifyUser({ userId: tenancy.tenantId, type: "account.role_changed", title: "Your roles changed", message: "The tenant role was removed from your account." });
  }
  await notifyUser({
    userId: tenancy.unit.property.ownerId,
    type: "tenancy.ended",
    title: "A tenancy ended",
    message: `${tenancy.tenant.fullName} is no longer the tenant of ${variables.unitName}.`,
    link: `/properties/${tenancy.unit.property.id}`,
  });
  return tenancy.id;
}
