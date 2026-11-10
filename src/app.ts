import fs from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { nudgeMailQueue } from "./services/mailer.js";
import announcementsRouter from "./modules/announcements/announcements.routes.js";
import auditRouter from "./modules/audit/audit.routes.js";
import authRouter from "./modules/auth/auth.routes.js";
import filesRouter from "./modules/files/files.routes.js";
import notificationsRouter from "./modules/notifications/notifications.routes.js";
import propertiesRouter from "./modules/properties/properties.routes.js";
import publicRouter from "./modules/public/public.routes.js";
import settingsRouter from "./modules/settings/settings.routes.js";
import tenanciesRouter from "./modules/tenancies/tenancies.routes.js";
import unitsRouter from "./modules/units/units.routes.js";
import usersRouter from "./modules/users/users.routes.js";

const app = express();

// Behind a proxy (Nginx or the host's load balancer), so the real visitor address is used for rate limits and the audit log.
const proxyHops = env.TRUST_PROXY ?? (env.isProduction ? 1 : 0);
if (proxyHops > 0) app.set("trust proxy", proxyHops);

// The site may load its fonts from Google Fonts and its map from OpenFreeMap. Nothing else.
// A paid map provider can be added with CSP_EXTRA_ORIGINS.
const extraOrigins = (env.CSP_EXTRA_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https://tiles.openfreemap.org", ...extraOrigins],
        connectSrc: ["'self'", "https://tiles.openfreemap.org", "https://nominatim.openstreetmap.org", ...extraOrigins],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        ...(env.isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
  })
);
// Keeps the email queue moving when the host paused the app while it was idle.
app.use((_request, _response, next) => {
  nudgeMailQueue();
  next();
});
app.use(cors({ origin: env.clientOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Only the public folder is served. Private files go through authenticated download routes.
app.use("/uploads", express.static(path.join(env.uploadRoot, "public"), { index: false, dotfiles: "deny", maxAge: "30d", immutable: true }));

app.get("/api/health", async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ ok: true, database: true });
  } catch {
    response.status(503).json({ ok: false, database: false });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/public", publicRouter);
app.use("/api/users", usersRouter);
app.use("/api/properties", propertiesRouter);
app.use("/api/files", filesRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/audit-logs", auditRouter);
app.use("/api", unitsRouter);
app.use("/api", tenanciesRouter);

// The website itself. In production one Node app serves both the API and the React pages,
// which is what hosts that run a single app per domain need.
function findClientDir(): string | null {
  const candidates = [env.CLIENT_DIR, path.resolve(__dirname, "../public"), path.resolve(__dirname, "../../client/dist")].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? null;
}
const clientDir = findClientDir();
if (clientDir) {
  // Built files have a hash in their name, so they can be cached for a year. A missing one is a real 404, never the app page.
  app.use("/assets", express.static(path.join(clientDir, "assets"), { index: false, dotfiles: "deny", maxAge: "1y", immutable: true }));
  app.use("/assets", (_request, response) => response.status(404).type("text/plain").send("Not found"));
  app.use(express.static(clientDir, { index: false, dotfiles: "deny", maxAge: 0 }));
  // Every other address (/homes, /login, /list ...) belongs to the React app. API and upload paths are left alone.
  app.get(/^\/(?!api\/|uploads\/).*/, (_request, response) => {
    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
