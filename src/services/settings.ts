import { env } from "../config/env.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { prisma } from "../lib/prisma.js";

export const DEFAULT_CURRENCY = "PHP";

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getCurrency(): Promise<string> {
  return (await getSetting("currency")) ?? DEFAULT_CURRENCY;
}

export type SmtpEncryption = "ssl" | "starttls";

export interface EmailSettings {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  adminAlertEmail: string;
}

interface StoredEmailSettings extends Omit<EmailSettings, "password"> {
  passwordEncrypted: string;
}

const EMAIL_KEY = "email.smtp";

function defaultsFromEnvironment(): EmailSettings {
  const port = env.SMTP_PORT ?? 465;
  return {
    host: env.SMTP_HOST ?? "",
    port,
    encryption: port === 465 ? "ssl" : "starttls",
    username: env.SMTP_USER ?? "",
    password: env.SMTP_PASSWORD ?? "",
    fromName: env.SMTP_FROM_NAME,
    fromAddress: env.SMTP_FROM_ADDRESS ?? env.SMTP_USER ?? "",
    replyTo: "",
    adminAlertEmail: env.ADMIN_ALERT_EMAIL ?? "",
  };
}

// Settings saved by a super admin win; environment variables are the fallback.
export async function getEmailSettings(): Promise<EmailSettings> {
  const stored = await getSetting(EMAIL_KEY);
  const defaults = defaultsFromEnvironment();
  if (!stored) return defaults;

  const parsed = JSON.parse(stored) as StoredEmailSettings;
  let password = "";
  try {
    password = parsed.passwordEncrypted ? decryptSecret(parsed.passwordEncrypted) : "";
  } catch {
    console.error("Stored SMTP password could not be decrypted; save the email settings again.");
  }
  const { passwordEncrypted: _ignored, ...rest } = parsed;
  return { ...defaults, ...rest, password };
}

export async function saveEmailSettings(settings: EmailSettings): Promise<void> {
  const { password, ...rest } = settings;
  const stored: StoredEmailSettings = { ...rest, passwordEncrypted: password ? encryptSecret(password) : "" };
  await setSetting(EMAIL_KEY, JSON.stringify(stored));
}

export const publicEmailSettings = (settings: EmailSettings) => {
  const { password, ...rest } = settings;
  return { ...rest, passwordSet: Boolean(password) };
};
