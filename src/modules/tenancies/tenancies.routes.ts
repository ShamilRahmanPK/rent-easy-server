import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "../../lib/audit.js";
import { routeParam } from "../../lib/http.js";
import { conflict, forbidden, notFound } from "../../lib/errors.js";
import { formatPropertyCode, formatUnitCode, formatUserCode } from "../../lib/formatCode.js";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { isoDateField, toDateOnly } from "../../lib/validation.js";
import { currentUser, isStaff, requireAuth, requireStaff, requireVerifiedEmail } from "../../middleware/auth.js";
import { assertIdentityComplete } from "../../services/accounts.js";
import { notifyAdmins, notifyUser } from "../../services/notifications.js";
import { createTenancy, endTenancy } from "../../services/tenancy.js";

// Mounted at /api. Authentication is added per route.
const tenanciesRouter = Router();

const today = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");

const createSchema = z.object({
  unitId: z.string().min(1),
  tenantId: z.string().min(1),
  startDate: isoDateField.optional(),
});
const endSchema = z.object({ endDate: isoDateField.optional() });
const requestSchema = z.object({ message: z.string().trim().max(1000).optional() });
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), startDate: isoDateField.optional() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().max(500).optional() }),
]);

const tenancyListSchema = paginationSchema.extend({
  status: z.enum(["Active", "Ended"]).optional(),
  unitId: z.string().optional(),
  tenantId: z.string().optional(),
});
const requestListSchema = paginationSchema.extend({ status: z.enum(["Pending", "Approved", "Rejected", "Cancelled"]).optional() });

const tenancyInclude = {
  unit: { include: { property: true } },
  tenant: { select: { id: true, userNumber: true, fullName: true, email: true } },
} satisfies Prisma.TenancyInclude;

type TenancyRecord = Prisma.TenancyGetPayload<{ include: typeof tenancyInclude }>;

function serializeTenancy(tenancy: TenancyRecord, viewer: { id: string; staff: boolean }) {
  const viewerIsPropertyOwner = tenancy.unit.property.ownerId === viewer.id;
  return {
    id: tenancy.id,
    status: tenancy.status,
    startDate: tenancy.startDate.toISOString().slice(0, 10),
    endDate: tenancy.endDate ? tenancy.endDate.toISOString().slice(0, 10) : null,
    unit: { id: tenancy.unit.id, code: formatUnitCode(tenancy.unit.unitSerial), unitNumber: tenancy.unit.unitNumber },
    property: { id: tenancy.unit.property.id, code: formatPropertyCode(tenancy.unit.property.propertyNumber), name: tenancy.unit.property.name },
    // Staff see the tenant's contact details; an owner sees name and ID; the tenant already knows who they are.
    tenant:
      viewer.staff || viewerIsPropertyOwner
        ? { id: tenancy.tenant.id, userId: formatUserCode(tenancy.tenant.userNumber), fullName: tenancy.tenant.fullName, ...(viewer.staff ? { email: tenancy.tenant.email } : {}) }
        : undefined,
    createdAt: tenancy.createdAt,
  };
}

// ───────────── Tenancies ─────────────

tenanciesRouter.post("/tenancies", requireAuth, requireStaff, async (request, response) => {
  const user = currentUser(request);
  const input = createSchema.parse(request.body);
  const tenancy = await createTenancy({
    unitId: input.unitId,
    tenantId: input.tenantId,
    startDate: input.startDate ? toDateOnly(input.startDate) : today(),
    createdById: user.id,
  });
  await writeAudit({ request, actorId: user.id, action: "tenancy.create", entity: "Tenancy", entityId: tenancy.id, after: input });
  const full = await prisma.tenancy.findUniqueOrThrow({ where: { id: tenancy.id }, include: tenancyInclude });
  response.status(201).json(serializeTenancy(full, { id: user.id, staff: true }));
});

tenanciesRouter.get("/tenancies", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const { page, pageSize, status, unitId, tenantId } = tenancyListSchema.parse(request.query);

  const where: Prisma.TenancyWhereInput = {
    ...(isStaff(user) ? {} : { OR: [{ tenantId: user.id }, { unit: { property: { ownerId: user.id } } }] }),
    ...(status ? { status } : {}),
    ...(unitId ? { unitId } : {}),
    ...(tenantId && isStaff(user) ? { tenantId } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.tenancy.count({ where }),
    prisma.tenancy.findMany({ where, include: tenancyInclude, orderBy: { createdAt: "desc" }, ...pageWindow(page, pageSize) }),
  ]);
  response.json(pageResult(rows.map((row) => serializeTenancy(row, { id: user.id, staff: isStaff(user) })), total, page, pageSize));
});

tenanciesRouter.post("/tenancies/:id/end", requireAuth, requireStaff, async (request, response) => {
  const user = currentUser(request);
  const { endDate } = endSchema.parse(request.body ?? {});
  const tenancyId = await endTenancy(routeParam(request, "id"), endDate ? toDateOnly(endDate) : today());
  await writeAudit({ request, actorId: user.id, action: "tenancy.end", entity: "Tenancy", entityId: tenancyId });
  const full = await prisma.tenancy.findUniqueOrThrow({ where: { id: tenancyId }, include: tenancyInclude });
  response.json(serializeTenancy(full, { id: user.id, staff: true }));
});

// ───────────── Rent requests ─────────────

const requestInclude = {
  unit: { include: { property: true } },
  user: { select: { id: true, userNumber: true, fullName: true, email: true } },
} satisfies Prisma.RentRequestInclude;

type RentRequestRecord = Prisma.RentRequestGetPayload<{ include: typeof requestInclude }>;

const serializeRentRequest = (item: RentRequestRecord, staff: boolean) => ({
  id: item.id,
  status: item.status,
  message: item.message,
  decisionNote: item.decisionNote,
  decidedAt: item.decidedAt,
  createdAt: item.createdAt,
  unit: { id: item.unit.id, code: formatUnitCode(item.unit.unitSerial), unitNumber: item.unit.unitNumber, monthlyRent: Number(item.unit.monthlyRent) },
  property: { id: item.unit.property.id, code: formatPropertyCode(item.unit.property.propertyNumber), name: item.unit.property.name },
  ...(staff ? { requester: { id: item.user.id, userId: formatUserCode(item.user.userNumber), fullName: item.user.fullName, email: item.user.email } } : {}),
});

tenanciesRouter.post("/units/:unitId/rent-requests", requireAuth, requireVerifiedEmail, async (request, response) => {
  const user = currentUser(request);
  const { message } = requestSchema.parse(request.body ?? {});

  const unit = await prisma.unit.findFirst({
    where: { id: routeParam(request, "unitId"), status: "Vacant", property: { approvalStatus: "Approved", listingStatus: "Listed" } },
    include: { property: true },
  });
  if (!unit) throw notFound("This unit is not available to rent");
  if (unit.property.ownerId === user.id) throw forbidden("You cannot rent your own unit");

  // Asking early means the admin can approve without a second round of paperwork.
  assertIdentityComplete(await prisma.user.findUniqueOrThrow({ where: { id: user.id } }));

  if (await prisma.rentRequest.findFirst({ where: { unitId: unit.id, userId: user.id, status: "Pending" } })) {
    throw conflict("You already have a pending request for this unit");
  }

  const created = await prisma.rentRequest.create({ data: { unitId: unit.id, userId: user.id, message }, include: requestInclude });
  await writeAudit({ request, actorId: user.id, action: "rent_request.create", entity: "RentRequest", entityId: created.id });
  await notifyAdmins({
    type: "rent_request.received",
    title: "New rent request",
    message: `${user.fullName} asked to rent ${unit.unitNumber} at ${unit.property.name}.`,
    link: `/admin/rent-requests/${created.id}`,
    email: { template: "rent_request_received", variables: { requesterName: user.fullName, unitName: unit.unitNumber, propertyName: unit.property.name } },
  });
  response.status(201).json(serializeRentRequest(created, false));
});

tenanciesRouter.get("/rent-requests", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const { page, pageSize, status } = requestListSchema.parse(request.query);
  const where: Prisma.RentRequestWhereInput = { ...(isStaff(user) ? {} : { userId: user.id }), ...(status ? { status } : {}) };

  const [total, rows] = await Promise.all([
    prisma.rentRequest.count({ where }),
    prisma.rentRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: "desc" }, ...pageWindow(page, pageSize) }),
  ]);
  response.json(pageResult(rows.map((row) => serializeRentRequest(row, isStaff(user))), total, page, pageSize));
});

tenanciesRouter.post("/rent-requests/:id/cancel", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const item = await prisma.rentRequest.findUnique({ where: { id: routeParam(request, "id") } });
  if (!item || item.userId !== user.id) throw notFound("Request not found");
  if (item.status !== "Pending") throw conflict("Only a pending request can be cancelled");

  const updated = await prisma.rentRequest.update({ where: { id: item.id }, data: { status: "Cancelled", decidedAt: new Date() }, include: requestInclude });
  response.json(serializeRentRequest(updated, false));
});

tenanciesRouter.post("/rent-requests/:id/decision", requireAuth, requireStaff, async (request, response) => {
  const staff = currentUser(request);
  const decision = decisionSchema.parse(request.body);
  const item = await prisma.rentRequest.findUnique({ where: { id: routeParam(request, "id") }, include: requestInclude });
  if (!item) throw notFound("Request not found");
  if (item.status !== "Pending") throw conflict("This request was already decided");

  if (decision.action === "approve") {
    const tenancy = await createTenancy({
      unitId: item.unitId,
      tenantId: item.userId,
      startDate: decision.startDate ? toDateOnly(decision.startDate) : today(),
      createdById: staff.id,
      approvedRequestId: item.id,
    });
    await prisma.rentRequest.update({ where: { id: item.id }, data: { status: "Approved", decidedById: staff.id, decidedAt: new Date() } });
    await writeAudit({ request, actorId: staff.id, action: "rent_request.approve", entity: "RentRequest", entityId: item.id, after: { tenancyId: tenancy.id } });
  } else {
    await prisma.rentRequest.update({ where: { id: item.id }, data: { status: "Rejected", decidedById: staff.id, decidedAt: new Date(), decisionNote: decision.note ?? null } });
    await writeAudit({ request, actorId: staff.id, action: "rent_request.reject", entity: "RentRequest", entityId: item.id, after: { note: decision.note } });
    await notifyUser({
      userId: item.userId,
      type: "rent_request.rejected",
      title: "Rent request not approved",
      message: decision.note || `Your request for ${item.unit.unitNumber} was not approved.`,
      email: { template: "rent_request_rejected", variables: { unitName: item.unit.unitNumber, note: decision.note || "Please contact us if you have questions." } },
    });
  }

  const updated = await prisma.rentRequest.findUniqueOrThrow({ where: { id: item.id }, include: requestInclude });
  response.json(serializeRentRequest(updated, true));
});

export default tenanciesRouter;
