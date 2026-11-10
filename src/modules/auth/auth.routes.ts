import { Router } from "express";
import type { Request } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sha256 } from "../../lib/crypto.js";
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";
import { serializeUser, userInclude } from "../../lib/serializers.js";
import { clearSessionCookie, createSessionToken, setSessionCookie } from "../../lib/session.js";
import { emailField, passwordField, phoneField } from "../../lib/validation.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import {
  TOKEN_LIFETIME,
  assertTokenRateLimit,
  consumeAuthToken,
  createAuthToken,
  invalidateTokens,
} from "../../services/authTokens.js";
import { queueMail } from "../../services/mailer.js";
import { appLink, notifyUser } from "../../services/notifications.js";

const authRouter = Router();

const BCRYPT_COST = 12;
const MAX_FAILED_LOGINS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_COST);

const registerSchema = z.object({
  email: emailField,
  password: passwordField,
  fullName: z.string().trim().min(1, "Full name is required").max(100),
  phone: phoneField.optional(),
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(200),
});

const tokenSchema = z.object({ token: z.string().min(20).max(200) });
const forgotPasswordSchema = z.object({ email: emailField });
const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordField });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordField });

async function sendVerificationEmail(user: { id: string; email: string; fullName: string }) {
  await assertTokenRateLimit(user.id, "email_verify");
  const token = await createAuthToken(user.id, "email_verify", TOKEN_LIFETIME.email_verify);
  await queueMail({
    to: user.email,
    template: "verify_email",
    variables: { name: user.fullName, link: appLink(`/verify-email?token=${token}`) },
  });
}

function deviceDetails(request: Request) {
  const userAgent = (request.headers["user-agent"] ?? "unknown device").slice(0, 200);
  return { userAgent, fingerprint: sha256(userAgent) };
}

// Alerts the person when a sign-in comes from a device they have not used before.
// The very first device is learned silently, so a new account does not get an alert.
async function checkNewDevice(user: { id: string; fullName: string }, request: Request) {
  const { userAgent, fingerprint } = deviceDetails(request);
  const known = await prisma.loginDevice.findUnique({ where: { userId_fingerprint: { userId: user.id, fingerprint } } });

  if (known) {
    await prisma.loginDevice.update({ where: { id: known.id }, data: { lastSeenAt: new Date() } });
    return;
  }

  const deviceCount = await prisma.loginDevice.count({ where: { userId: user.id } });
  await prisma.loginDevice.create({ data: { userId: user.id, fingerprint, userAgent } });
  if (deviceCount === 0) return;

  await notifyUser({
    userId: user.id,
    type: "security.new_login",
    title: "New sign-in to your account",
    message: `A sign-in from a new device was detected: ${userAgent.slice(0, 80)}`,
    email: { template: "new_login_alert", variables: { device: userAgent.slice(0, 120), time: new Date().toUTCString() } },
  });
}

authRouter.post("/register", authLimiter, async (request, response) => {
  const input = registerSchema.parse(request.body);

  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    throw conflict("Email already in use");
  }

  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      phone: input.phone,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
      roles: { create: { role: "user" } },
    },
    include: userInclude,
  });

  await sendVerificationEmail(user);
  await writeAudit({ request, actorId: user.id, action: "user.register", entity: "User", entityId: user.id });

  setSessionCookie(response, createSessionToken(user));
  response.status(201).json(serializeUser(user, { includeIdentity: true }));
});

authRouter.post("/login", authLimiter, async (request, response) => {
  const input = loginSchema.parse(request.body);
  const user = await prisma.user.findUnique({ where: { email: input.email }, include: userInclude });

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw tooManyRequests(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }

  const passwordMatches = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordMatches) {
    if (user) {
      const windowExpired = !user.firstFailedLoginAt || Date.now() - user.firstFailedLoginAt.getTime() > LOGIN_WINDOW_MS;
      const failedCount = windowExpired ? 1 : user.failedLoginCount + 1;
      const lock = failedCount >= MAX_FAILED_LOGINS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failedCount,
          firstFailedLoginAt: lock ? null : windowExpired ? new Date() : user.firstFailedLoginAt,
          lockedUntil: lock ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      });
    }
    throw unauthorized("Invalid email or password");
  }

  if (user.status !== "Active") throw forbidden(`This account is ${user.status.toLowerCase()}`);

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, firstFailedLoginAt: null, lockedUntil: null, lastLoginAt: new Date() },
  });
  await checkNewDevice(user, request);

  setSessionCookie(response, createSessionToken(user));
  response.json(serializeUser(user, { includeIdentity: true }));
});

authRouter.post("/logout", (_request, response) => {
  clearSessionCookie(response);
  response.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (request, response) => {
  const authUser = currentUser(request);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: authUser.id }, include: userInclude });
  const unreadNotifications = await prisma.notification.count({ where: { userId: authUser.id, readAt: null } });
  response.json({ ...serializeUser(user, { includeIdentity: true }), unreadNotifications });
});

authRouter.post("/verify-email", authLimiter, async (request, response) => {
  const { token } = tokenSchema.parse(request.body);
  const userId = await consumeAuthToken(token, "email_verify");
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  await notifyUser({ userId, type: "account.email_verified", title: "Email verified", message: "Your email address is verified." });
  response.json({ ok: true });
});

authRouter.post("/resend-verification", requireAuth, async (request, response) => {
  const authUser = currentUser(request);
  if (authUser.emailVerified) throw conflict("Your email is already verified");
  await sendVerificationEmail({ id: authUser.id, email: authUser.email, fullName: authUser.fullName });
  response.json({ ok: true });
});

// Always answers the same way, so nobody can use it to find out which emails have accounts.
authRouter.post("/forgot-password", authLimiter, async (request, response) => {
  const { email } = forgotPasswordSchema.parse(request.body);
  const user = await prisma.user.findUnique({ where: { email } });

  if (user && user.status === "Active") {
    try {
      await assertTokenRateLimit(user.id, "password_reset");
      const token = await createAuthToken(user.id, "password_reset", TOKEN_LIFETIME.password_reset);
      await queueMail({
        to: user.email,
        template: "reset_password",
        variables: { name: user.fullName, link: appLink(`/reset-password?token=${token}`) },
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Too many")) console.error("Password reset failed:", error);
    }
  }
  response.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
});

authRouter.post("/reset-password", authLimiter, async (request, response) => {
  const { token, password } = resetPasswordSchema.parse(request.body);
  const userId = await consumeAuthToken(token, "password_reset");

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      tokenVersion: { increment: 1 },
      emailVerified: true,
      failedLoginCount: 0,
      firstFailedLoginAt: null,
      lockedUntil: null,
    },
  });
  await invalidateTokens(userId, "password_reset");
  await writeAudit({ request, actorId: userId, action: "user.password_reset", entity: "User", entityId: userId });
  await notifyUser({
    userId,
    type: "security.password_changed",
    title: "Password changed",
    message: "Your password was changed. Other devices were signed out.",
    email: { template: "password_changed" },
  });
  clearSessionCookie(response);
  response.json({ ok: true, email: user.email });
});

authRouter.post("/change-password", requireAuth, async (request, response) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);
  const authUser = currentUser(request);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: authUser.id } });

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest("Current password is incorrect");
  if (currentPassword === newPassword) throw badRequest("Choose a password different from the current one");

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_COST), tokenVersion: { increment: 1 } },
  });
  await writeAudit({ request, actorId: user.id, action: "user.password_change", entity: "User", entityId: user.id });
  await notifyUser({
    userId: user.id,
    type: "security.password_changed",
    title: "Password changed",
    message: "Your password was changed. Other devices were signed out.",
    email: { template: "password_changed" },
  });

  // Keep this device signed in with a fresh session; every other device is signed out.
  setSessionCookie(response, createSessionToken(updated));
  response.json({ ok: true });
});

export default authRouter;
