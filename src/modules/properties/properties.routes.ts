import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "../../lib/audit.js";
import { routeParam } from "../../lib/http.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../lib/errors.js";
import { pageResult, pageWindow, paginationSchema } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { serializeProperty } from "../../lib/propertySerializers.js";
import { AMENITIES } from "../../lib/validation.js";
import { toUnitData, unitFields } from "../units/unit.schema.js";
import { currentUser, isStaff, isSuperAdmin, requireAuth, requireStaff, requireVerifiedEmail } from "../../middleware/auth.js";
import { uploadLimiter } from "../../middleware/rateLimit.js";
import { documentUpload, imageUpload } from "../../middleware/upload.js";
import { assertIdentityComplete, grantRole } from "../../services/accounts.js";
import { removeStoredFiles, serializeFile, storeImage, storePrivateFile } from "../../services/files.js";
import { notifyAdmins, notifyUser } from "../../services/notifications.js";
import {
  MAX_OWNERSHIP_DOCUMENTS,
  MAX_PROPERTY_PHOTOS,
  MIN_PROPERTY_PHOTOS,
  loadManageableProperty,
} from "../../services/propertyAccess.js";

const propertiesRouter = Router();

const currentYear = new Date().getFullYear();

const propertyFields = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  propertyType: z.enum(["apartment_building", "condominium", "house", "townhouse", "commercial"]),
  description: z.string().trim().max(2000).nullable().optional(),
  streetAddress: z.string().trim().min(1, "Street address is required").max(200),
  city: z.string().trim().min(1, "City is required").max(100),
  province: z.string().trim().min(1, "Province or state is required").max(100),
  postalCode: z.string().trim().max(20).nullable().optional(),
  landmark: z.string().trim().max(120).nullable().optional(),
  country: z.string().trim().min(1, "Country is required").max(100),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  yearBuilt: z.coerce.number().int().min(1800).max(currentYear + 5).nullable().optional(),
  totalFloors: z.coerce.number().int().min(1).max(200).nullable().optional(),
  parkingSlots: z.coerce.number().int().min(0).max(10000).nullable().optional(),
  amenities: z.array(z.enum(AMENITIES)).max(AMENITIES.length).optional(),
});

// A new property may come with its first home, so one short form is enough to start a listing.
const createSchema = propertyFields.extend({ unit: unitFields.optional() });
const updateSchema = propertyFields.partial().strict();

function assertCoordinatesPair(data: { latitude?: number | null; longitude?: number | null }) {
  const hasLatitude = data.latitude !== undefined && data.latitude !== null;
  const hasLongitude = data.longitude !== undefined && data.longitude !== null;
  if (hasLatitude !== hasLongitude) throw badRequest("Give both latitude and longitude, or neither");
}

const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(5, "Explain the reason in at least 5 characters").max(1000) }),
]);

const listingSchema = z.object({ listingStatus: z.enum(["Listed", "Hidden"]) });

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  approval: z.enum(["Pending", "Approved", "Rejected"]).optional(),
  listing: z.enum(["Draft", "Listed", "Hidden", "Archived"]).optional(),
  queue: z.enum(["pending"]).optional(),
  ownerId: z.string().max(50).optional(),
});

const propertyDetailInclude = {
  files: true,
  units: { include: { files: true }, orderBy: { unitNumber: "asc" } },
  owner: { select: { id: true, userNumber: true, fullName: true, email: true } },
  _count: { select: { units: true } },
} satisfies Prisma.PropertyInclude;

async function loadDetail(propertyId: string) {
  return prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: propertyDetailInclude });
}

// ───────────── Create, list, read ─────────────

propertiesRouter.post("/", requireAuth, requireVerifiedEmail, async (request, response) => {
  const user = currentUser(request);
  const { unit: firstHome, ...input } = createSchema.parse(request.body);
  assertCoordinatesPair(input);

  const property = await prisma.$transaction(async (tx) => {
    const created = await tx.property.create({ data: { ...input, amenities: input.amenities ?? [], ownerId: user.id } });
    if (firstHome) {
      await tx.unit.create({
        data: { ...toUnitData(firstHome), propertyId: created.id, unitNumber: firstHome.unitNumber, unitType: firstHome.unitType, bedrooms: firstHome.bedrooms, bathrooms: firstHome.bathrooms, floorArea: firstHome.floorArea, furnishing: firstHome.furnishing, monthlyRent: firstHome.monthlyRent, features: firstHome.features ?? [] },
      });
    }
    return created;
  });
  await writeAudit({ request, actorId: user.id, action: "property.create", entity: "Property", entityId: property.id });
  response.status(201).json(serializeProperty(await loadDetail(property.id), { includeDocuments: true }));
});

propertiesRouter.get("/", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const { page, pageSize, q, approval, listing, queue, ownerId } = listQuerySchema.parse(request.query);

  const where: Prisma.PropertyWhereInput = {
    ...(isStaff(user) ? (ownerId ? { ownerId } : {}) : { ownerId: user.id }),
    ...(approval ? { approvalStatus: approval } : {}),
    ...(listing ? { listingStatus: listing } : {}),
    // The admin review queue: submitted and still waiting for a decision.
    ...(queue === "pending" ? { approvalStatus: "Pending", submittedAt: { not: null } } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
            { streetAddress: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, properties] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({
      where,
      include: { files: { where: { kind: "property_photo" } }, owner: propertyDetailInclude.owner, _count: propertyDetailInclude._count },
      orderBy: queue === "pending" ? { submittedAt: "asc" } : { createdAt: "desc" },
      ...pageWindow(page, pageSize),
    }),
  ]);

  response.json(pageResult(properties.map((property) => serializeProperty(property, { includeOwner: isStaff(user) })), total, page, pageSize));
});

propertiesRouter.get("/:id", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const property = await loadManageableProperty(user, routeParam(request, "id"));
  response.json(serializeProperty(await loadDetail(property.id), { includeDocuments: true, includeOwner: isStaff(user) }));
});

// ───────────── Edit, submit, review, list, archive ─────────────

propertiesRouter.patch("/:id", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const property = await loadManageableProperty(user, routeParam(request, "id"));
  if (property.listingStatus === "Archived") throw conflict("This property is archived");

  const changes = updateSchema.parse(request.body);
  assertCoordinatesPair({
    latitude: changes.latitude === undefined ? property.latitude : changes.latitude,
    longitude: changes.longitude === undefined ? property.longitude : changes.longitude,
  });

  const updated = await prisma.property.update({ where: { id: property.id }, data: changes });
  await writeAudit({ request, actorId: user.id, action: "property.update", entity: "Property", entityId: property.id, before: property, after: updated });

  if (user.id !== property.ownerId) {
    await notifyUser({
      userId: property.ownerId,
      type: "property.edited",
      title: "Your property was edited by an admin",
      message: `An admin updated the details of ${updated.name}.`,
      link: `/properties/${property.id}`,
    });
  }
  response.json(serializeProperty(await loadDetail(property.id), { includeDocuments: true, includeOwner: isStaff(user) }));
});

propertiesRouter.post("/:id/submit", requireAuth, requireVerifiedEmail, async (request, response) => {
  const user = currentUser(request);
  const property = await loadManageableProperty(user, routeParam(request, "id"));
  if (property.ownerId !== user.id) throw forbidden("Only the owner can submit a property for approval");

  if (property.approvalStatus === "Approved") throw conflict("This property is already approved");
  if (property.approvalStatus === "Pending" && property.submittedAt) throw conflict("This property is already waiting for review");

  const owner = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assertIdentityComplete(owner);

  const [photoCount, documentCount] = await Promise.all([
    prisma.fileAsset.count({ where: { propertyId: property.id, kind: "property_photo" } }),
    prisma.fileAsset.count({ where: { propertyId: property.id, kind: "ownership_document" } }),
  ]);
  const problems: string[] = [];
  if (photoCount < MIN_PROPERTY_PHOTOS) problems.push(`Add at least ${MIN_PROPERTY_PHOTOS} photos (you have ${photoCount})`);
  if (documentCount < 1) problems.push("Upload at least one ownership document");
  if (problems.length > 0) throw unprocessable("The property is not ready to submit", problems);

  // A rejected property is resubmitted as the same record; the earlier reason is cleared.
  const submitted = await prisma.property.update({
    where: { id: property.id },
    data: { approvalStatus: "Pending", submittedAt: new Date(), rejectionReason: null, reviewedAt: null, reviewedById: null },
  });
  await writeAudit({ request, actorId: user.id, action: "property.submit", entity: "Property", entityId: property.id });

  await notifyUser({
    userId: user.id,
    type: "property.received",
    title: "Property submitted",
    message: `We received ${submitted.name}. An admin will review it soon.`,
    link: `/properties/${property.id}`,
    email: { template: "property_received", variables: { propertyName: submitted.name } },
  });
  await notifyAdmins(
    {
      type: "property.review_needed",
      title: "New property to review",
      message: `${owner.fullName} submitted ${submitted.name}.`,
      link: `/admin/properties/${property.id}`,
      email: { template: "property_review_needed", variables: { propertyName: submitted.name, ownerName: owner.fullName } },
    },
    user.id
  );
  response.json(serializeProperty(await loadDetail(property.id), { includeDocuments: true }));
});

propertiesRouter.post("/:id/review", requireAuth, requireStaff, async (request, response) => {
  const reviewer = currentUser(request);
  const decision = reviewSchema.parse(request.body);
  const property = await prisma.property.findUnique({ where: { id: routeParam(request, "id") } });
  if (!property) throw notFound("Property not found");

  if (!property.submittedAt || property.approvalStatus !== "Pending") throw conflict("This property is not waiting for review");
  if (property.ownerId === reviewer.id && !isSuperAdmin(reviewer)) throw forbidden("Another admin must review your own property");

  const link = `/properties/${property.id}`;

  if (decision.action === "approve") {
    const roleAdded = await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id: property.id },
        data: { approvalStatus: "Approved", listingStatus: "Listed", rejectionReason: null, reviewedById: reviewer.id, reviewedAt: new Date() },
      });
      return grantRole(tx, property.ownerId, "owner");
    });
    await writeAudit({ request, actorId: reviewer.id, action: "property.approve", entity: "Property", entityId: property.id });
    await notifyUser({
      userId: property.ownerId,
      type: "property.approved",
      title: "Property approved",
      message: `${property.name} was approved and is now listed.`,
      link,
      email: { template: "property_approved", variables: { propertyName: property.name } },
    });
    if (roleAdded) {
      await notifyUser({
        userId: property.ownerId,
        type: "account.role_changed",
        title: "You are now an owner",
        message: "The owner role was added to your account.",
      });
    }
  } else {
    await prisma.property.update({
      where: { id: property.id },
      data: { approvalStatus: "Rejected", listingStatus: "Draft", rejectionReason: decision.reason, reviewedById: reviewer.id, reviewedAt: new Date() },
    });
    await writeAudit({ request, actorId: reviewer.id, action: "property.reject", entity: "Property", entityId: property.id, after: { reason: decision.reason } });
    await notifyUser({
      userId: property.ownerId,
      type: "property.rejected",
      title: "Property needs changes",
      message: `${property.name} was not approved: ${decision.reason}`,
      link,
      email: { template: "property_rejected", variables: { propertyName: property.name, reason: decision.reason } },
    });
  }

  response.json(serializeProperty(await loadDetail(property.id), { includeDocuments: true, includeOwner: true }));
});

propertiesRouter.patch("/:id/listing", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const { listingStatus } = listingSchema.parse(request.body);
  const property = await loadManageableProperty(user, routeParam(request, "id"));

  if (property.approvalStatus !== "Approved") throw conflict("Only approved properties can be listed or hidden");
  if (property.listingStatus === "Archived" && !isStaff(user)) throw forbidden("Only an admin can restore an archived property");
  if (property.listingStatus === listingStatus) throw conflict(`The property is already ${listingStatus.toLowerCase()}`);

  await prisma.property.update({ where: { id: property.id }, data: { listingStatus } });
  await writeAudit({ request, actorId: user.id, action: "property.listing", entity: "Property", entityId: property.id, before: { listingStatus: property.listingStatus }, after: { listingStatus } });
  response.json(serializeProperty(await loadDetail(property.id), { includeDocuments: true, includeOwner: isStaff(user) }));
});

// Archiving keeps the record (it may be linked to tenancies) and removes it from the public site at once.
propertiesRouter.delete("/:id", requireAuth, requireStaff, async (request, response) => {
  const user = currentUser(request);
  const property = await prisma.property.findUnique({ where: { id: routeParam(request, "id") } });
  if (!property) throw notFound("Property not found");
  if (property.listingStatus === "Archived") throw conflict("The property is already archived");

  const occupied = await prisma.tenancy.count({ where: { status: "Active", unit: { propertyId: property.id } } });
  if (occupied > 0) throw conflict("This property has active tenancies. End them before archiving.");

  await prisma.property.update({ where: { id: property.id }, data: { listingStatus: "Archived" } });
  await writeAudit({ request, actorId: user.id, action: "property.archive", entity: "Property", entityId: property.id });
  await notifyUser({
    userId: property.ownerId,
    type: "property.archived",
    title: "Property archived",
    message: `${property.name} was archived and is no longer listed.`,
  });
  response.json({ ok: true });
});

// ───────────── Photos and documents ─────────────

propertiesRouter.post("/:id/photos", requireAuth, uploadLimiter, imageUpload(MAX_PROPERTY_PHOTOS, 5).array("photos", MAX_PROPERTY_PHOTOS), async (request, response) => {
  const user = currentUser(request);
  const property = await loadManageableProperty(user, routeParam(request, "id"));
  const files = (request.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest('Attach images in the "photos" field');

  const existing = await prisma.fileAsset.count({ where: { propertyId: property.id, kind: "property_photo" } });
  if (existing + files.length > MAX_PROPERTY_PHOTOS) {
    throw unprocessable(`A property can have at most ${MAX_PROPERTY_PHOTOS} photos (it has ${existing})`);
  }

  const created = [];
  for (const [index, file] of files.entries()) {
    const stored = await storeImage(file, `properties/${property.id}`);
    created.push(
      await prisma.fileAsset.create({
        data: {
          kind: "property_photo",
          propertyId: property.id,
          storagePath: stored.storagePath,
          thumbPath: stored.thumbPath,
          sizeBytes: stored.sizeBytes,
          originalName: file.originalname,
          mimeType: "image/webp",
          isCover: existing === 0 && index === 0,
          sortOrder: existing + index,
        },
      })
    );
  }
  await writeAudit({ request, actorId: user.id, action: "property.add_photos", entity: "Property", entityId: property.id, after: { count: created.length } });
  response.status(201).json(created.map(serializeFile));
});

propertiesRouter.post("/:id/documents", requireAuth, uploadLimiter, documentUpload(MAX_OWNERSHIP_DOCUMENTS, 10).array("documents", MAX_OWNERSHIP_DOCUMENTS), async (request, response) => {
  const user = currentUser(request);
  const property = await loadManageableProperty(user, routeParam(request, "id"));
  const files = (request.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest('Attach files in the "documents" field');

  const existing = await prisma.fileAsset.count({ where: { propertyId: property.id, kind: "ownership_document" } });
  if (existing + files.length > MAX_OWNERSHIP_DOCUMENTS) {
    throw unprocessable(`At most ${MAX_OWNERSHIP_DOCUMENTS} ownership documents are allowed (there are ${existing})`);
  }

  const created = [];
  const stored = [];
  try {
    for (const file of files) {
      const saved = await storePrivateFile(file, `properties/${property.id}`);
      stored.push(saved.storagePath);
      created.push(
        await prisma.fileAsset.create({
          data: {
            kind: "ownership_document",
            isPrivate: true,
            propertyId: property.id,
            storagePath: saved.storagePath,
            sizeBytes: saved.sizeBytes,
            mimeType: saved.mimeType,
            originalName: file.originalname,
          },
        })
      );
    }
  } catch (error) {
    await removeStoredFiles(...stored);
    await prisma.fileAsset.deleteMany({ where: { id: { in: created.map((item) => item.id) } } });
    throw error;
  }
  await writeAudit({ request, actorId: user.id, action: "property.add_documents", entity: "Property", entityId: property.id, after: { count: created.length } });
  response.status(201).json(created.map(serializeFile));
});

export default propertiesRouter;
