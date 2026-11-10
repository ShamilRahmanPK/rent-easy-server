import { Router } from "express";
import bcrypt from "bcryptjs";
import type { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "../../lib/audit.js";
import { routeParam } from "../../lib/http.js";
import { randomToken } from "../../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { serializeUser, sortRoles, userInclude } from "../../lib/serializers.js";
import { ageInYears, emailField, isoDateField, phoneField, toDateOnly } from "../../lib/validation.js";
import { currentUser, hasAnyRole, isSuperAdmin, requireAuth, requireStaff, requireSuperAdmin, type AuthUser } from "../../middleware/auth.js";
import { documentUpload, imageUpload } from "../../middleware/upload.js";
import { uploadLimiter } from "../../middleware/rateLimit.js";
import { grantRole, revokeRole } from "../../services/accounts.js";
import { TOKEN_LIFETIME, createAuthToken } from "../../services/authTokens.js";
import { removeStoredFiles, serializeFile, storeImage, storePrivateFile } from "../../services/files.js";
import { queueMail } from "../../services/mailer.js";
import { appLink, notifyUser } from "../../services/notifications.js";

const usersRouter = Router();
usersRouter.use(requireAuth);

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const profileSchema = z
  .object({
    fullName: z.string().trim().min(1).max(100),
    phone: phoneField.nullable(),
    dateOfBirth: isoDateField.nullable(),
    address: optionalText(300),
    city: optionalText(100),
    country: optionalText(100),
    // emirates_id and national_id are kept so accounts created earlier stay valid.
    idType: z.enum(["passport", "philsys", "umid", "driving_license", "postal_id", "sss_id", "voters_id", "prc_id", "national_id", "emirates_id", "other"]).nullable(),
    idNumber: z.string().trim().min(3).max(50).nullable(),
    notifyInApp: z.boolean(),
    notifyEmailUpdates: z.boolean(),
  })
  .partial()
  .strict();

const statusSchema = z.object({
  status: z.enum(["Active", "Suspended", "Deactivated"]),
  note: z.string().trim().max(500).optional(),
});

const grantableRoleSchema = z.object({ role: z.enum(["tenant", "owner", "admin", "super_admin"]) });

const staffSchema = z.object({
  email: emailField,
  fullName: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "super_admin"]),
});

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  role: z.enum(["user", "tenant", "owner", "admin", "super_admin"]).optional(),
  status: z.enum(["Active", "Suspended", "Deactivated"]).optional(),
});

// ───────────── My own profile ─────────────

usersRouter.patch("/me", async (request, response) => {
  const authUser = currentUser(request);
  const changes = profileSchema.parse(request.body);

  if (changes.dateOfBirth) {
    const dateOfBirth = toDateOnly(changes.dateOfBirth);
    const age = ageInYears(dateOfBirth);
    if (dateOfBirth > new Date() || age > 120) throw badRequest("Enter a real date of birth");
    if (age < 18 && hasAnyRole(authUser, ["owner", "tenant"])) throw badRequest("Owners and tenants must be 18 or older");
  }

  const data: Prisma.UserUpdateInput = {
    fullName: changes.fullName,
    phone: changes.phone,
    address: changes.address,
    city: changes.city,
    country: changes.country,
    idType: changes.idType,
    idNumber: changes.idNumber,
    notifyInApp: changes.notifyInApp,
    notifyEmailUpdates: changes.notifyEmailUpdates,
    dateOfBirth: changes.dateOfBirth === undefined ? undefined : changes.dateOfBirth === null ? null : toDateOnly(changes.dateOfBirth),
  };

  const user = await prisma.user.update({ where: { id: authUser.id }, data, include: userInclude });
  await writeAudit({ request, actorId: authUser.id, action: "user.update_profile", entity: "User", entityId: authUser.id, after: Object.keys(changes) });
  response.json(serializeUser(user, { includeIdentity: true }));
});

usersRouter.post("/me/avatar", uploadLimiter, imageUpload(1, 2).single("avatar"), async (request, response) => {
  const authUser = currentUser(request);
  if (!request.file) throw badRequest('Attach an image in the "avatar" field');

  const stored = await storeImage(request.file, "avatars", { large: 512, thumb: 128 });
  const previous = await prisma.fileAsset.findMany({ where: { userId: authUser.id, kind: "avatar" } });

  const asset = await prisma.fileAsset.create({
    data: {
      kind: "avatar",
      userId: authUser.id,
      storagePath: stored.storagePath,
      thumbPath: stored.thumbPath,
      sizeBytes: stored.sizeBytes,
      originalName: request.file.originalname,
      mimeType: "image/webp",
    },
  });
  const file = serializeFile(asset);
  await prisma.user.update({ where: { id: authUser.id }, data: { avatarUrl: file.url } });

  await prisma.fileAsset.deleteMany({ where: { id: { in: previous.map((item) => item.id) } } });
  await removeStoredFiles(...previous.flatMap((item) => [item.storagePath, item.thumbPath]));
  response.status(201).json({ avatarUrl: file.url });
});

usersRouter.post("/me/id-document", uploadLimiter, documentUpload(1, 10).single("document"), async (request, response) => {
  const authUser = currentUser(request);
  if (!request.file) throw badRequest('Attach a file in the "document" field');

  const stored = await storePrivateFile(request.file, "ids");
  const previous = await prisma.fileAsset.findMany({ where: { userId: authUser.id, kind: "id_document" } });

  const asset = await prisma.fileAsset.create({
    data: {
      kind: "id_document",
      isPrivate: true,
      userId: authUser.id,
      storagePath: stored.storagePath,
      sizeBytes: stored.sizeBytes,
      mimeType: stored.mimeType,
      originalName: request.file.originalname,
    },
  });
  await prisma.user.update({ where: { id: authUser.id }, data: { idDocumentFileId: asset.id } });

  await prisma.fileAsset.deleteMany({ where: { id: { in: previous.map((item) => item.id) } } });
  await removeStoredFiles(...previous.map((item) => item.storagePath));
  await writeAudit({ request, actorId: authUser.id, action: "user.upload_id_document", entity: "User", entityId: authUser.id });
  response.status(201).json(serializeFile(asset));
});

// ───────────── Admin: people and roles ─────────────

usersRouter.post("/staff", requireSuperAdmin, async (request, response) => {
  const actor = currentUser(request);
  const input = staffSchema.parse(request.body);

  if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict("Email already in use");

  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      passwordHash: await bcrypt.hash(randomToken(24), 12),
      emailVerified: true,
      roles: { create: [{ role: "user" }, { role: input.role }] },
    },
    include: userInclude,
  });

  // The new admin sets their own password through a one-time link.
  const token = await createAuthToken(user.id, "password_reset", TOKEN_LIFETIME.staff_invite);
  await queueMail({
    to: user.email,
    template: "staff_invite",
    variables: { name: user.fullName, role: input.role.replace("_", " "), link: appLink(`/reset-password?token=${token}`) },
  });
  await prisma.notification.create({
    data: { userId: user.id, type: "account.welcome", title: "Welcome to the team", message: `You were added as ${input.role.replace("_", " ")}.` },
  });
  await writeAudit({ request, actorId: actor.id, action: "user.create_staff", entity: "User", entityId: user.id, after: { email: user.email, role: input.role } });
  response.status(201).json(serializeUser(user));
});

usersRouter.get("/", requireStaff, async (request, response) => {
  const { page, pageSize, q, role, status } = listQuerySchema.parse(request.query);

  const where: Prisma.UserWhereInput = {
    ...(status ? { status } : {}),
    ...(role ? { roles: { some: { role } } } : {}),
    ...(q
      ? {
          OR: [
            { fullName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            ...(/^\d+$/.test(q) ? [{ userNumber: Number(q) }] : []),
          ],
        }
      : {}),
  };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, include: userInclude, orderBy: { userNumber: "asc" }, ...pageWindow(page, pageSize) }),
  ]);
  response.json(pageResult(users.map((user) => serializeUser(user)), total, page, pageSize));
});

usersRouter.get("/:id", requireStaff, async (request, response) => {
  const user = await prisma.user.findUnique({ where: { id: routeParam(request, "id") }, include: userInclude });
  if (!user) throw notFound("User not found");

  const [propertyCount, activeTenancies] = await Promise.all([
    prisma.property.count({ where: { ownerId: user.id } }),
    prisma.tenancy.count({ where: { tenantId: user.id, status: "Active" } }),
  ]);
  response.json({ ...serializeUser(user, { includeIdentity: true }), propertyCount, activeTenancies });
});

const hasStaffRole = (roles: Role[]) => roles.includes("admin") || roles.includes("super_admin");

async function loadManageableTarget(actor: AuthUser, targetId: string) {
  if (targetId === actor.id) throw forbidden("You cannot change your own account here");
  const target = await prisma.user.findUnique({ where: { id: targetId }, include: userInclude });
  if (!target) throw notFound("User not found");

  const targetRoles = target.roles.map((entry) => entry.role);
  // Only a super admin may touch another admin or super admin.
  if (hasStaffRole(targetRoles) && !isSuperAdmin(actor)) throw forbidden("Only a super admin can change an admin account");
  return { target, targetRoles };
}

async function assertNotLastSuperAdmin(targetId: string) {
  const others = await prisma.user.count({
    where: { id: { not: targetId }, status: "Active", roles: { some: { role: "super_admin" } } },
  });
  if (others === 0) throw conflict("At least one active super admin must remain");
}

usersRouter.patch("/:id/status", requireStaff, async (request, response) => {
  const actor = currentUser(request);
  const { status, note } = statusSchema.parse(request.body);
  const { target, targetRoles } = await loadManageableTarget(actor, routeParam(request, "id"));

  if (target.status === status) throw conflict(`The account is already ${status.toLowerCase()}`);
  if (status !== "Active" && targetRoles.includes("super_admin")) await assertNotLastSuperAdmin(target.id);

  // Raising tokenVersion signs the person out everywhere straight away.
  const statusUpdate: Prisma.UserUpdateInput = status === "Active" ? { status } : { status, tokenVersion: { increment: 1 } };
  const updated = await prisma.user.update({ where: { id: target.id }, data: statusUpdate, include: userInclude });

  await writeAudit({ request, actorId: actor.id, action: "user.change_status", entity: "User", entityId: target.id, before: { status: target.status }, after: { status, note } });
  await notifyUser({
    userId: target.id,
    type: "account.status_changed",
    title: `Account ${status.toLowerCase()}`,
    message: note || `Your account is now ${status.toLowerCase()}.`,
    email: {
      template: "account_status_changed",
      variables: { status: status.toLowerCase(), note: note || (status === "Active" ? "You can sign in again." : "Contact support if you think this is a mistake.") },
    },
  });
  response.json(serializeUser(updated));
});

// Which roles each kind of admin may grant or remove. Everyone always keeps the base "user" role.
function assertMayChangeRole(actor: AuthUser, role: Role) {
  if (role === "user") throw badRequest('The "user" role cannot be changed');
  if (isSuperAdmin(actor)) return;
  if (role !== "tenant") throw forbidden("Admins can only change the tenant role");
}

function roleChangeText(role: Role, granted: boolean) {
  const label = role.replace("_", " ");
  return `The ${label} role was ${granted ? "added to" : "removed from"} your account.`;
}

usersRouter.post("/:id/roles", requireStaff, async (request, response) => {
  const actor = currentUser(request);
  const { role } = grantableRoleSchema.parse(request.body);
  assertMayChangeRole(actor, role);
  const { target } = await loadManageableTarget(actor, routeParam(request, "id"));

  if ((role === "admin" || role === "super_admin") && !target.emailVerified) throw conflict("The person must verify their email before becoming an admin");

  const added = await prisma.$transaction((tx) => grantRole(tx, target.id, role));
  if (!added) throw conflict("The person already has this role");

  const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: userInclude });
  const roles = sortRoles(updated.roles.map((entry) => entry.role));
  await writeAudit({ request, actorId: actor.id, action: "user.grant_role", entity: "User", entityId: target.id, after: { role } });
  await notifyUser({
    userId: target.id,
    type: "account.role_changed",
    title: "Your roles changed",
    message: roleChangeText(role, true),
    email: { template: "role_changed", variables: { change: roleChangeText(role, true), roles: roles.join(", ") } },
  });
  response.status(201).json(serializeUser(updated));
});

usersRouter.delete("/:id/roles/:role", requireStaff, async (request, response) => {
  const actor = currentUser(request);
  const { role } = grantableRoleSchema.parse({ role: routeParam(request, "role") });
  assertMayChangeRole(actor, role);
  const { target } = await loadManageableTarget(actor, routeParam(request, "id"));

  if (role === "super_admin") await assertNotLastSuperAdmin(target.id);
  if (role === "tenant" && (await prisma.tenancy.count({ where: { tenantId: target.id, status: "Active" } })) > 0) {
    throw conflict("End the person's active tenancy before removing the tenant role");
  }
  if (role === "owner" && (await prisma.property.count({ where: { ownerId: target.id, listingStatus: { not: "Archived" } } })) > 0) {
    throw conflict("This person still owns properties. Archive them first.");
  }

  const removed = await prisma.$transaction((tx) => revokeRole(tx, target.id, role));
  if (!removed) throw conflict("The person does not have this role");

  const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: userInclude });
  const roles = sortRoles(updated.roles.map((entry) => entry.role));
  await writeAudit({ request, actorId: actor.id, action: "user.revoke_role", entity: "User", entityId: target.id, before: { role } });
  await notifyUser({
    userId: target.id,
    type: "account.role_changed",
    title: "Your roles changed",
    message: roleChangeText(role, false),
    email: { template: "role_changed", variables: { change: roleChangeText(role, false), roles: roles.join(", ") } },
  });
  response.json(serializeUser(updated));
});

export default usersRouter;
