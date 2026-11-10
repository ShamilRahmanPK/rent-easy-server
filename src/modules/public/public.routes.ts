import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { routeParam } from "../../lib/http.js";
import { notFound } from "../../lib/errors.js";
import { formatPropertyCode, formatUnitCode } from "../../lib/formatCode.js";
import { pageResult } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { money } from "../../lib/serializers.js";
import { photosOf, serializeUnit } from "../../lib/propertySerializers.js";
import { AMENITIES } from "../../lib/validation.js";
import { publicLimiter } from "../../middleware/rateLimit.js";
import { getCurrency } from "../../services/settings.js";

const publicRouter = Router();
publicRouter.use(publicLimiter);

// A unit is public only while it is vacant and its property is approved and listed.
const publiclyVisible: Prisma.UnitWhereInput = {
  status: "Vacant",
  property: { approvalStatus: "Approved", listingStatus: "Listed" },
};

const listingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  q: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  minRent: z.coerce.number().min(0).optional(),
  maxRent: z.coerce.number().min(0).optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  bathrooms: z.coerce.number().min(0).max(20).optional(),
  propertyType: z.enum(["apartment_building", "condominium", "house", "townhouse", "commercial"]).optional(),
  furnishing: z.enum(["Unfurnished", "SemiFurnished", "FullyFurnished"]).optional(),
  amenities: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(AMENITIES))),
  sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),
});

publicRouter.get("/config", async (_request, response) => {
  response.json({ currency: await getCurrency() });
});

// Values the search screen needs to build its filters.
publicRouter.get("/filters", async (_request, response) => {
  const [cityRows, rent] = await Promise.all([
    prisma.$queryRaw<Array<{ city: string; count: number }>>`
      SELECT p."city" AS city, COUNT(*)::int AS count
      FROM "Unit" u JOIN "Property" p ON p."id" = u."propertyId"
      WHERE u."status" = 'Vacant' AND p."approvalStatus" = 'Approved' AND p."listingStatus" = 'Listed'
      GROUP BY p."city" ORDER BY count DESC, p."city" ASC`,
    prisma.unit.aggregate({ where: publiclyVisible, _min: { monthlyRent: true }, _max: { monthlyRent: true } }),
  ]);
  const cities = [...cityRows].sort((a, b) => a.city.localeCompare(b.city));
  response.json({
    currency: await getCurrency(),
    cities: cities.map((row) => row.city),
    cityCounts: cityRows,
    rent: { min: money(rent._min.monthlyRent), max: money(rent._max.monthlyRent) },
    propertyTypes: ["apartment_building", "condominium", "house", "townhouse", "commercial"],
    amenities: AMENITIES,
  });
});

publicRouter.get("/listings", async (request, response) => {
  const query = listingQuerySchema.parse(request.query);

  const where: Prisma.UnitWhereInput = {
    ...publiclyVisible,
    ...(query.minRent !== undefined || query.maxRent !== undefined
      ? { monthlyRent: { ...(query.minRent !== undefined ? { gte: query.minRent } : {}), ...(query.maxRent !== undefined ? { lte: query.maxRent } : {}) } }
      : {}),
    ...(query.bedrooms !== undefined ? { bedrooms: { gte: query.bedrooms } } : {}),
    ...(query.bathrooms !== undefined ? { bathrooms: { gte: query.bathrooms } } : {}),
    ...(query.furnishing ? { furnishing: query.furnishing } : {}),
    property: {
      approvalStatus: "Approved",
      listingStatus: "Listed",
      ...(query.city ? { city: { equals: query.city, mode: "insensitive" } } : {}),
      ...(query.propertyType ? { propertyType: query.propertyType } : {}),
      ...(query.amenities.length > 0 ? { amenities: { hasEvery: query.amenities } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { city: { contains: query.q, mode: "insensitive" } },
              { streetAddress: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
  };

  const orderBy: Prisma.UnitOrderByWithRelationInput[] =
    query.sort === "price_asc" ? [{ monthlyRent: "asc" }, { id: "asc" }] : query.sort === "price_desc" ? [{ monthlyRent: "desc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }];

  const [total, units, currency] = await Promise.all([
    prisma.unit.count({ where }),
    prisma.unit.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { files: { where: { kind: "unit_photo" } }, property: { include: { files: { where: { kind: "property_photo" } } } } },
    }),
    getCurrency(),
  ]);

  const items = units.map((unit) => {
    const gallery = [...photosOf(unit.files, "unit_photo"), ...photosOf(unit.property.files, "property_photo")].slice(0, 5);
    const cover = gallery[0] ?? null;
    return {
      id: unit.id,
      code: formatUnitCode(unit.unitSerial),
      unitNumber: unit.unitNumber,
      unitType: unit.unitType,
      bedrooms: unit.bedrooms,
      bathrooms: money(unit.bathrooms),
      floorArea: money(unit.floorArea),
      furnishing: unit.furnishing,
      monthlyRent: money(unit.monthlyRent),
      availableFrom: unit.availableFrom ? unit.availableFrom.toISOString().slice(0, 10) : null,
      coverPhoto: cover,
      photos: gallery,
      utilities: unit.utilities,
      petsAllowed: unit.petsAllowed,
      minLeaseMonths: unit.minLeaseMonths,
      property: {
        id: unit.property.id,
        code: formatPropertyCode(unit.property.propertyNumber),
        name: unit.property.name,
        propertyType: unit.property.propertyType,
        city: unit.property.city,
        province: unit.property.province,
        landmark: unit.property.landmark,
        country: unit.property.country,
      },
    };
  });

  response.json({ currency, ...pageResult(items, total, query.page, query.pageSize) });
});

publicRouter.get("/listings/:unitId", async (request, response) => {
  const unit = await prisma.unit.findFirst({
    where: { id: routeParam(request, "unitId"), ...publiclyVisible },
    include: { files: true, property: { include: { files: { where: { kind: "property_photo" } } } } },
  });
  if (!unit) throw notFound("Listing not found");

  const { property } = unit;
  const unitView = serializeUnit(unit);
  response.json({
    currency: await getCurrency(),
    unit: unitView,
    gallery: [...unitView.photos, ...photosOf(property.files, "property_photo")],
    property: {
      id: property.id,
      code: formatPropertyCode(property.propertyNumber),
      name: property.name,
      propertyType: property.propertyType,
      description: property.description,
      address: { street: property.streetAddress, city: property.city, province: property.province, postalCode: property.postalCode, landmark: property.landmark, country: property.country },
      location: property.latitude !== null && property.longitude !== null ? { latitude: property.latitude, longitude: property.longitude } : null,
      yearBuilt: property.yearBuilt,
      totalFloors: property.totalFloors,
      parkingSlots: property.parkingSlots,
      amenities: property.amenities,
    },
  });
});

export default publicRouter;
