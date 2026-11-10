import path from "node:path";
import { env } from "./config/env.js";
import app from "./app.js";
import { startJobs } from "./jobs/index.js";
import { prisma } from "./lib/prisma.js";
import { ensureUploadDirectories } from "./services/files.js";

async function main() {
  await ensureUploadDirectories();
  console.log(`Uploads are stored in ${env.uploadRoot}`);
  if (env.isProduction && env.uploadRoot.startsWith(process.cwd() + path.sep)) {
    console.log("Note: that folder is inside the app folder. On a host that replaces the app folder on every deploy (such as Hostinger Web Apps), set UPLOAD_DIR to a folder outside it, or uploaded photos will be lost on update.");
  }
  const server = app.listen(env.PORT, () => {
    console.log(`API on port ${env.PORT} (${env.NODE_ENV}, mail: ${env.MAIL_MODE})`);
  });
  const stopJobs = startJobs();

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopJobs();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
