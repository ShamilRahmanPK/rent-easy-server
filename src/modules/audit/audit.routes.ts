import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireStaff } from "../../middleware/auth.js";

const auditRouter = Router();
auditRouter.use(requireAuth, requireStaff);

const querySchema = paginationSchema.extend({
  entity: z.string().max(50).optional(),
  entityId: z.string().max(60).optional(),
  actorId: z.string().max(60).optional(),
  action: z.string().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditRouter.get("/", async (request, response) => {
  const { page, pageSize, entity, entityId, actorId, action, from, to } = querySchema.parse(request.query);
  const where: Prisma.AuditLogWhereInput = {
    ...(entity ? { entity } : {}),
    ...(entityId ? { entityId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { actor: { select: { id: true, fullName: true, email: true } } },
      ...pageWindow(page, pageSize),
    }),
  ]);
  response.json(pageResult(rows, total, page, pageSize));
});

export default auditRouter;
