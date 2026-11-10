import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Creates the first super admin (the one account nobody can create from the screen) and the default settings.
// Safe to run more than once.
async function main() {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const fullName = process.env.SEED_SUPER_ADMIN_NAME?.trim() || "Super Admin";

  if (!email || !password) {
    throw new Error("Set SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD in .env first");
  }
  if (password.length < 8) throw new Error("SEED_SUPER_ADMIN_PASSWORD must be at least 8 characters");

  const existing = await prisma.user.findUnique({ where: { email } });
  const user =
    existing ??
    (await prisma.user.create({
      data: { email, fullName, passwordHash: await bcrypt.hash(password, 12), emailVerified: true },
    }));

  for (const role of ["user", "super_admin"] as const) {
    await prisma.userRole.upsert({ where: { userId_role: { userId: user.id, role } }, create: { userId: user.id, role }, update: {} });
  }
  await prisma.user.update({ where: { id: user.id }, data: { status: "Active", emailVerified: true } });

  await prisma.systemSetting.upsert({ where: { key: "currency" }, create: { key: "currency", value: "PHP" }, update: {} });

  console.log(`${existing ? "Updated" : "Created"} super admin ${email}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
