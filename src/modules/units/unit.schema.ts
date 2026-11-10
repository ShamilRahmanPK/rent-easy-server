import { z } from "zod";
import { UNIT_FEATURES, isoDateField, moneyField, toDateOnly } from "../../lib/validation.js";

const halfSteps = (value: number) => Number.isInteger(value * 2);

export const unitFields = z.object({
  unitNumber: z.string().trim().min(1, "Unit number is required").max(30),
  floor: z.coerce.number().int().min(-5).max(200).nullable().optional(),
  unitType: z.enum(["studio", "one_bedroom", "two_bedroom", "three_bedroom", "house", "room"]),
  bedrooms: z.coerce.number().int().min(0).max(20),
  bathrooms: z.coerce.number().min(0).max(20).refine(halfSteps, "Bathrooms go in steps of 0.5, for example 1, 1.5, 2"),
  floorArea: moneyField.max(100_000),
  furnishing: z.enum(["Unfurnished", "SemiFurnished", "FullyFurnished"]),
  monthlyRent: moneyField,
  securityDeposit: z.coerce.number().min(0).max(999_999_999.99).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "Use at most two decimal places").nullable().optional(),
  minLeaseMonths: z.coerce.number().int().min(1).max(120).nullable().optional(),
  noticePeriodMonths: z.coerce.number().int().min(0).max(12).nullable().optional(),
  utilities: z.enum(["NotIncluded", "Partly", "AllIncluded"]).optional(),
  availableFrom: isoDateField.nullable().optional(),
  petsAllowed: z.boolean().optional(),
  smokingAllowed: z.boolean().optional(),
  features: z.array(z.enum(UNIT_FEATURES)).max(UNIT_FEATURES.length).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

export type UnitInput = z.infer<typeof unitFields>;

// Converts validated input to what Prisma stores (the date arrives as text).
export function toUnitData(input: Partial<UnitInput>) {
  const { availableFrom, ...rest } = input;
  return {
    ...rest,
    ...(availableFrom === undefined ? {} : { availableFrom: availableFrom === null ? null : toDateOnly(availableFrom) }),
  };
}
