import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  APP_URL: z.string().default("http://localhost:5173"),
  UPLOAD_DIR: z.string().default("./uploads"),
  // Folder holding the built website (index.html and assets). Found automatically when it sits next to the server.
  CLIENT_DIR: z.string().optional(),
  // How many proxies sit in front of the API (Nginx, the host's load balancer). Used for the visitor's real address.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).optional(),
  // Extra web addresses the page may load maps or images from, comma-separated (for example a paid map provider).
  CSP_EXTRA_ORIGINS: z.string().optional(),
  SETTINGS_ENCRYPTION_KEY: z.string().optional(),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  UPLOAD_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  PUBLIC_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  MAIL_MODE: z.enum(["smtp", "console"]).default("console"),
  MAIL_REDIRECT_TO: z.string().optional(),
  ADMIN_ALERT_EMAIL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_NAME: z.string().default("RentEasy"),
  SMTP_FROM_ADDRESS: z.string().optional(),
});

const parsed = environmentSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const values = parsed.data;

export const env = {
  ...values,
  isProduction: values.NODE_ENV === "production",
  clientOrigins: values.CLIENT_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
  appUrl: values.APP_URL.replace(/\/+$/, ""),
  uploadRoot: path.resolve(values.UPLOAD_DIR),
};
