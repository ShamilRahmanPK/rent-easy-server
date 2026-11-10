import { z } from "zod";

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address").max(254));

export const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters");

// Money with at most two decimals, entered as number or numeric string.
export const moneyField = z.coerce
  .number()
  .positive("Amount must be greater than zero")
  .max(999_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "Use at most two decimal places");

export const optionalMoneyField = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  moneyField.optional()
);

export const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid date");

export const AMENITIES = [
  "swimming_pool",
  "gym",
  "security",
  "elevator",
  "parking",
  "playground",
  "garden",
  "cctv",
  "generator",
] as const;

export const UNIT_FEATURES = [
  "air_conditioning",
  "balcony",
  "kitchen_appliances",
  "washing_machine",
  "internet_ready",
  "parking_included",
] as const;

export function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function ageInYears(dateOfBirth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (now.getUTCMonth() === dateOfBirth.getUTCMonth() && now.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export const phoneField = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, "Enter a valid phone number, for example +63 917 123 4567");
