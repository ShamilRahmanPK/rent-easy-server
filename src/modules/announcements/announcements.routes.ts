import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../lib/audit.js";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { currentUser, requireAuth, requireStaff } from "../../middleware/auth.js";
import { notifyUser } from "../../services/notifications.js";

const announcementsRouter = Router();
announcementsRouter.use(requireAuth, requireStaff);

const sendSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
  audience: z.enum(["all", "owners", "tenants"]),
});

const audienceFilter = {
  all: {},
  owners: { roles: { some: { role: "owner" as const } } },
  tenants: { roles: { some: { role: "tenant" as const } } },
};

announcementsRouter.post("/", async (request, response) => {
  const sender = currentUser(request);
  const input = sendSchema.parse(request.body);

  const recipients = await prisma.user.findMany({ where: { status: "Active", ...audienceFilter[input.audience] }, select: { id: true } });
  const announcement = await prisma.announcement.create({
    data: { title: input.title, message: input.message, audience: input.audience, sentById: sender.id, recipientCount: recipients.length },
  });
  await writeAudit({ request, actorId: sender.id, action: "announcement.send", entity: "Announcement", entityId: announcement.id, after: { audience: input.audience, recipients: recipients.length } });

  // Delivery runs in the background in small groups, so a large audience never makes the admin wait.
  void (async () => {
    for (let start = 0; start < recipients.length; start += 25) {
      await Promise.all(
        recipients.slice(start, start + 25).map((recipient) =>
          notifyUser({
            userId: recipient.id,
            type: "announcement",
            title: input.title,
            message: input.message,
            email: { template: "announcement", variables: { title: input.title, message: input.message } },
          })
        )
      );
    }
  })().catch((error) => console.error("Announcement delivery failed:", error));

  response.status(201).json(announcement);
});

announcementsRouter.get("/", async (request, response) => {
  const { page, pageSize } = paginationSchema.parse(request.query);
  const [total, rows] = await Promise.all([
    prisma.announcement.count(),
    prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, include: { sentBy: { select: { fullName: true } } }, ...pageWindow(page, pageSize) }),
  ]);
  response.json(pageResult(rows, total, page, pageSize));
});

export default announcementsRouter;
