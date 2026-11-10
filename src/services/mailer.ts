import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getEmailSettings } from "./settings.js";
import { renderTemplate } from "./mailTemplates.js";

const RETRY_DELAYS_MINUTES = [1, 10, 60];
const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

interface QueueMailInput {
  to: string;
  template: string;
  variables: Record<string, string>;
}

// Puts an email in the outbox. Pages never wait for the mail server: the worker sends it.
export async function queueMail({ to, template, variables }: QueueMailInput): Promise<void> {
  const settings = await getEmailSettings();
  const rendered = await renderTemplate(template, variables, settings.fromName);
  await prisma.mailJob.create({
    data: { toEmail: to, subject: rendered.subject, html: rendered.html, text: rendered.text, template },
  });
  sendQueuedMailSoon();
}

// Tries to send at once, so nobody waits for the next timer tick. A failure stays in the queue and is retried.
export function sendQueuedMailSoon(): void {
  void processMailQueue().catch((error) => console.error("[mail] queue run failed:", error));
}

// Some hosts stop an idle app and start it again on the next visit, which pauses the timer.
// Every visit nudges the queue (at most every 30 seconds), so retries still happen.
let lastNudge = 0;
export function nudgeMailQueue(): void {
  if (Date.now() - lastNudge < 30_000) return;
  lastNudge = Date.now();
  sendQueuedMailSoon();
}

let cachedTransport: { key: string; transporter: Transporter } | null = null;

async function getTransport(): Promise<{ transporter: Transporter; from: string; replyTo?: string; mode: "smtp" | "console" }> {
  const settings = await getEmailSettings();
  const fromAddress = settings.fromAddress || settings.username || "noreply@localhost";
  const from = `"${settings.fromName.replace(/"/g, "")}" <${fromAddress}>`;
  const replyTo = settings.replyTo || undefined;

  if (env.MAIL_MODE === "console") {
    return { transporter: nodemailer.createTransport({ jsonTransport: true }), from, replyTo, mode: "console" };
  }

  if (!settings.host || !settings.username || !settings.password) {
    throw new Error("SMTP is not configured. A super admin must save the email settings.");
  }

  const key = JSON.stringify([settings.host, settings.port, settings.encryption, settings.username, settings.password]);
  if (!cachedTransport || cachedTransport.key !== key) {
    cachedTransport = {
      key,
      transporter: nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.encryption === "ssl",
        requireTLS: settings.encryption === "starttls",
        auth: { user: settings.username, pass: settings.password },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return { transporter: cachedTransport.transporter, from, replyTo, mode: "smtp" };
}

interface DeliveryInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function deliver({ to, subject, html, text }: DeliveryInput): Promise<{ mode: "smtp" | "console" }> {
  const { transporter, from, replyTo, mode } = await getTransport();
  const redirect = env.MAIL_REDIRECT_TO?.trim();
  const recipient = redirect || to;
  const finalSubject = redirect ? `[to ${to}] ${subject}` : subject;

  await transporter.sendMail({ from, replyTo, to: recipient, subject: finalSubject, html, text });

  if (mode === "console") {
    console.log(`\n[mail:console] to=${recipient}\nsubject: ${finalSubject}\n${text}\n`);
  }
  return { mode };
}

// Sends one message immediately, for the "Send test email" button.
export async function sendTestEmail(to: string): Promise<{ ok: boolean; mode?: string; error?: string }> {
  try {
    const settings = await getEmailSettings();
    const rendered = await renderTemplate("test_email", {}, settings.fromName);
    const { mode } = await deliver({ to, ...rendered });
    return { ok: true, mode };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let processing = false;

export async function processMailQueue(batchSize = 10): Promise<number> {
  if (processing) return 0;
  processing = true;
  let handled = 0;
  try {
    const due = await prisma.mailJob.findMany({
      where: { status: "Queued", runAt: { lte: new Date() } },
      orderBy: { runAt: "asc" },
      take: batchSize,
    });

    for (const job of due) {
      // Claim the job so a second worker (or an overlapping run) cannot send it twice.
      const claim = await prisma.mailJob.updateMany({
        where: { id: job.id, status: "Queued", runAt: { lte: new Date() } },
        data: { runAt: new Date(Date.now() + CLAIM_WINDOW_MS) },
      });
      if (claim.count === 0) continue;

      handled += 1;
      try {
        await deliver({ to: job.toEmail, subject: job.subject, html: job.html, text: job.text });
        await prisma.mailJob.update({
          where: { id: job.id },
          data: { status: "Sent", sentAt: new Date(), attempts: job.attempts + 1, lastError: null },
        });
      } catch (error) {
        await handleFailure(job, error);
      }
    }
  } finally {
    processing = false;
  }
  return handled;
}

async function handleFailure(job: { id: string; toEmail: string; template: string; attempts: number }, error: unknown) {
  const attempts = job.attempts + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);

  if (attempts >= MAX_ATTEMPTS) {
    await prisma.mailJob.update({ where: { id: job.id }, data: { status: "Failed", attempts, lastError: message } });
    await alertAdminOfFailure(job.toEmail, job.template, message);
    return;
  }

  const delayMinutes = RETRY_DELAYS_MINUTES[attempts - 1] ?? 60;
  await prisma.mailJob.update({
    where: { id: job.id },
    data: { attempts, lastError: message, runAt: new Date(Date.now() + delayMinutes * 60 * 1000) },
  });
}

async function alertAdminOfFailure(toEmail: string, template: string, error: string) {
  if (template === "mail_failure_alert") return;
  const settings = await getEmailSettings();
  if (!settings.adminAlertEmail) return;
  try {
    await queueMail({
      to: settings.adminAlertEmail,
      template: "mail_failure_alert",
      variables: { toEmail, template, error },
    });
  } catch (alertError) {
    console.error("Could not queue the mail failure alert:", alertError);
  }
}
