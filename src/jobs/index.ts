import { prisma } from "../lib/prisma.js";
import { processMailQueue } from "../services/mailer.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function cleanup() {
  const now = Date.now();
  const [notifications, tokens, mail] = await Promise.all([
    // Notifications are kept for 90 days.
    prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now - 90 * DAY_MS) } } }),
    prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date(now - 7 * DAY_MS) } } }),
    prisma.mailJob.deleteMany({ where: { status: "Sent", sentAt: { lt: new Date(now - 90 * DAY_MS) } } }),
  ]);
  const total = notifications.count + tokens.count + mail.count;
  if (total > 0) console.log(`[jobs] cleanup removed ${total} old records`);
}

function safely(name: string, task: () => Promise<unknown>) {
  return () => {
    task().catch((error) => console.error(`[jobs] ${name} failed:`, error));
  };
}

// Background work that runs inside the API process. Safe to run on more than one instance:
// mail jobs are claimed before sending, and cleanup is idempotent.
export function startJobs(): () => void {
  const timers = [
    setInterval(safely("mail queue", () => processMailQueue()), 10_000),
    setInterval(safely("cleanup", cleanup), 6 * 60 * 60 * 1000),
    setTimeout(safely("cleanup", cleanup), 60_000),
  ];
  timers.forEach((timer) => timer.unref());
  return () => timers.forEach((timer) => clearInterval(timer));
}
