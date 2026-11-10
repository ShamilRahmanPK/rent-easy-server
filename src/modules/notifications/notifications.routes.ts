import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { routeParam } from "../../lib/http.js";
import { notFound } from "../../lib/errors.js";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";

const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const listSchema = paginationSchema.extend({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const present = (item: { id: string; type: string; title: string; message: string; link: string | null; readAt: Date | null; createdAt: Date }) => ({
  id: item.id,
  type: item.type,
  title: item.title,
  message: item.message,
  link: item.link,
  read: item.readAt !== null,
  readAt: item.readAt,
  createdAt: item.createdAt,
});

notificationsRouter.get("/", async (request, response) => {
  const user = currentUser(request);
  const { page, pageSize, unread } = listSchema.parse(request.query);
  const where: Prisma.NotificationWhereInput = { userId: user.id, ...(unread ? { readAt: null } : {}) };

  const [total, unreadCount, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, ...pageWindow(page, pageSize) }),
  ]);
  response.json({ unreadCount, ...pageResult(rows.map(present), total, page, pageSize) });
});

// Light endpoint for the bell icon; the screen can poll it every 30 seconds.
notificationsRouter.get("/unread-count", async (request, response) => {
  response.json({ unreadCount: await prisma.notification.count({ where: { userId: currentUser(request).id, readAt: null } }) });
});

notificationsRouter.post("/read-all", async (request, response) => {
  const result = await prisma.notification.updateMany({ where: { userId: currentUser(request).id, readAt: null }, data: { readAt: new Date() } });
  response.json({ updated: result.count });
});

notificationsRouter.patch("/:id/read", async (request, response) => {
  const user = currentUser(request);
  const item = await prisma.notification.findFirst({ where: { id: routeParam(request, "id"), userId: user.id } });
  if (!item) throw notFound("Notification not found");
  const updated = item.readAt ? item : await prisma.notification.update({ where: { id: item.id }, data: { readAt: new Date() } });
  response.json(present(updated));
});

notificationsRouter.delete("/:id", async (request, response) => {
  const result = await prisma.notification.deleteMany({ where: { id: routeParam(request, "id"), userId: currentUser(request).id } });
  if (result.count === 0) throw notFound("Notification not found");
  response.json({ ok: true });
});

export default notificationsRouter;
