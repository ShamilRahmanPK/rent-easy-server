import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../lib/audit.js";
import { routeParam } from "../../lib/http.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import type { Prisma } from "@prisma/client";
import { currentUser, requireAuth, requireSuperAdmin } from "../../middleware/auth.js";
import { sendTestEmail } from "../../services/mailer.js";
import { TEMPLATES } from "../../services/mailTemplates.js";
import { getCurrency, getEmailSettings, publicEmailSettings, saveEmailSettings, setSetting } from "../../services/settings.js";

const settingsRouter = Router();
settingsRouter.use(requireAuth, requireSuperAdmin);

const optionalEmail = z.union([z.literal(""), z.email().max(254)]);

const emailSettingsSchema = z.object({
  host: z.string().trim().min(1).max(200),
  port: z.coerce.number().int().min(1).max(65535),
  encryption: z.enum(["ssl", "starttls"]),
  username: z.string().trim().min(1).max(200),
  // Left out (or empty) means "keep the saved password".
  password: z.string().max(500).optional(),
  fromName: z.string().trim().min(1).max(100),
  fromAddress: z.email().max(254),
  replyTo: optionalEmail.default(""),
  adminAlertEmail: optionalEmail.default(""),
});

const templateSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyHtml: z.string().trim().min(1).max(20_000),
});

settingsRouter.get("/general", async (_request, response) => {
  response.json({ currency: await getCurrency() });
});

settingsRouter.put("/general", async (request, response) => {
  const { currency } = z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code, for example PHP") }).parse(request.body);
  const before = await getCurrency();
  await setSetting("currency", currency);
  await writeAudit({ request, actorId: currentUser(request).id, action: "settings.currency", entity: "SystemSetting", entityId: "currency", before: { currency: before }, after: { currency } });
  response.json({ currency });
});

settingsRouter.get("/email", async (_request, response) => {
  response.json(publicEmailSettings(await getEmailSettings()));
});

settingsRouter.put("/email", async (request, response) => {
  const input = emailSettingsSchema.parse(request.body);
  const current = await getEmailSettings();

  await saveEmailSettings({ ...input, password: input.password ? input.password : current.password });
  // The password itself is never written to the audit log.
  await writeAudit({
    request,
    actorId: currentUser(request).id,
    action: "settings.email",
    entity: "SystemSetting",
    entityId: "email.smtp",
    after: { host: input.host, port: input.port, encryption: input.encryption, username: input.username, fromAddress: input.fromAddress, passwordChanged: Boolean(input.password) },
  });
  response.json(publicEmailSettings(await getEmailSettings()));
});

settingsRouter.post("/email/test", async (request, response) => {
  const user = currentUser(request);
  const { to } = z.object({ to: z.email().optional() }).parse(request.body ?? {});
  const result = await sendTestEmail(to ?? user.email);
  response.status(result.ok ? 200 : 502).json(result);
});

// ───────────── Email wording ─────────────

async function describeTemplate(key: string) {
  const definition = TEMPLATES[key];
  const override = await prisma.emailTemplate.findUnique({ where: { key } });
  return {
    key,
    essential: definition.essential,
    placeholders: definition.placeholders,
    customised: Boolean(override),
    subject: override?.subject ?? definition.subject,
    bodyHtml: override?.bodyHtml ?? definition.body,
    defaultSubject: definition.subject,
    defaultBodyHtml: definition.body,
  };
}

settingsRouter.get("/email-templates", async (_request, response) => {
  response.json(await Promise.all(Object.keys(TEMPLATES).map(describeTemplate)));
});

settingsRouter.get("/email-templates/:key", async (request, response) => {
  const key = routeParam(request, "key");
  if (!TEMPLATES[key]) throw notFound("Template not found");
  response.json(await describeTemplate(key));
});

settingsRouter.put("/email-templates/:key", async (request, response) => {
  const key = routeParam(request, "key");
  const definition = TEMPLATES[key];
  if (!definition) throw notFound("Template not found");
  const input = templateSchema.parse(request.body);

  if (/<\s*script|javascript:|\son\w+\s*=/i.test(input.bodyHtml + input.subject)) {
    throw badRequest("Scripts and event handlers are not allowed in email wording");
  }
  const used = [...(input.subject + input.bodyHtml).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]);
  const unknown = [...new Set(used.filter((name) => !definition.placeholders.includes(name)))];
  if (unknown.length > 0) throw badRequest(`Unknown placeholders: ${unknown.join(", ")}. Allowed: ${definition.placeholders.join(", ") || "none"}`);

  await prisma.emailTemplate.upsert({ where: { key }, create: { key, ...input }, update: input });
  await writeAudit({ request, actorId: currentUser(request).id, action: "settings.email_template", entity: "EmailTemplate", entityId: key });
  response.json(await describeTemplate(key));
});

settingsRouter.delete("/email-templates/:key", async (request, response) => {
  const key = routeParam(request, "key");
  if (!TEMPLATES[key]) throw notFound("Template not found");
  await prisma.emailTemplate.deleteMany({ where: { key } });
  await writeAudit({ request, actorId: currentUser(request).id, action: "settings.email_template_reset", entity: "EmailTemplate", entityId: key });
  response.json(await describeTemplate(key));
});

// ───────────── Mail log ─────────────

const mailLogQuerySchema = paginationSchema.extend({
  status: z.enum(["Queued", "Sent", "Failed"]).optional(),
  template: z.string().max(60).optional(),
  to: z.string().max(254).optional(),
});

// Every email the platform sends or tries to send: recipient, subject, time and result.
settingsRouter.get("/mail-log", async (request, response) => {
  const { page, pageSize, status, template, to } = mailLogQuerySchema.parse(request.query);
  const where: Prisma.MailJobWhereInput = {
    ...(status ? { status } : {}),
    ...(template ? { template } : {}),
    ...(to ? { toEmail: { contains: to, mode: "insensitive" } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.mailJob.count({ where }),
    prisma.mailJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: { id: true, toEmail: true, subject: true, template: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, runAt: true },
      ...pageWindow(page, pageSize),
    }),
  ]);
  response.json(pageResult(rows, total, page, pageSize));
});

settingsRouter.post("/mail-log/:id/retry", async (request, response) => {
  const job = await prisma.mailJob.findUnique({ where: { id: routeParam(request, "id") } });
  if (!job) throw notFound("Email not found");
  if (job.status !== "Failed") throw conflict("Only a failed email can be retried");
  const updated = await prisma.mailJob.update({ where: { id: job.id }, data: { status: "Queued", attempts: 0, lastError: null, runAt: new Date() }, select: { id: true, status: true } });
  await writeAudit({ request, actorId: currentUser(request).id, action: "mail.retry", entity: "MailJob", entityId: job.id });
  response.json(updated);
});

export default settingsRouter;
