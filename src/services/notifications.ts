import type { Role } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { isEssentialTemplate } from "./mailTemplates.js";
import { queueMail } from "./mailer.js";

export const appLink = (path: string) => `${env.appUrl}${path.startsWith("/") ? path : `/${path}`}`;

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  // Front-end path, for example "/properties/abc". Emails turn it into a full URL.
  link?: string;
  email?: { template: string; variables?: Record<string, string> };
}

// Creates the in-app notification and queues the email, honouring the person's preferences.
// A failure here is logged and never blocks the action that caused it.
export async function notifyUser(input: NotifyInput): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, fullName: true, notifyInApp: true, notifyEmailUpdates: true },
    });
    if (!user) return;

    const essential = input.email ? isEssentialTemplate(input.email.template) : false;

    if (user.notifyInApp || essential) {
      await prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          link: input.link ?? null,
        },
      });
    }

    if (input.email && (essential || user.notifyEmailUpdates)) {
      await queueMail({
        to: user.email,
        template: input.email.template,
        variables: {
          name: user.fullName,
          ...(input.link ? { link: appLink(input.link) } : {}),
          ...input.email.variables,
        },
      });
    }
  } catch (error) {
    console.error(`Notification "${input.type}" for user ${input.userId} failed:`, error);
  }
}

export async function notifyUsers(userIds: string[], build: (userId: string) => Omit<NotifyInput, "userId">) {
  await Promise.all([...new Set(userIds)].map((userId) => notifyUser({ userId, ...build(userId) })));
}

export async function findActiveUserIdsWithRoles(roles: Role[]): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { status: "Active", roles: { some: { role: { in: roles } } } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function notifyAdmins(input: Omit<NotifyInput, "userId">, excludeUserId?: string) {
  const adminIds = (await findActiveUserIdsWithRoles(["admin", "super_admin"])).filter((id) => id !== excludeUserId);
  await Promise.all(adminIds.map((userId) => notifyUser({ userId, ...input })));
}
