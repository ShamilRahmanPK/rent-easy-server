import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../lib/audit.js";
import { routeParam } from "../../lib/http.js";
import { badRequest, conflict, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { serializeUnit } from "../../lib/propertySerializers.js";
import { unitFields, toUnitData } from "./unit.schema.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { uploadLimiter } from "../../middleware/rateLimit.js";
import { imageUpload } from "../../middleware/upload.js";
import { removeStoredFiles, serializeFile, storeImage } from "../../services/files.js";
import { notifyUser } from "../../services/notifications.js";
import { MAX_UNIT_PHOTOS, loadManageableProperty, loadManageableUnit } from "../../services/propertyAccess.js";

// Mounted at /api. Authentication is added per route so public routes mounted later are not affected.
const unitsRouter = Router();

const createUnitSchema = unitFields;
const updateUnitSchema = unitFields.partial().strict();
const statusSchema = z.object({ status: z.enum(["Vacant", "UnderMaintenance"]) });

async function assertUnitNumberFree(propertyId: string, unitNumber: string, exceptUnitId?: string) {
  const clash = await prisma.unit.findFirst({
    where: { propertyId, unitNumber: { equals: unitNumber, mode: "insensitive" }, ...(exceptUnitId ? { id: { not: exceptUnitId } } : {}) },
  });
  if (clash) throw conflict(`Unit "${unitNumber}" already exists in this property`);
}

unitsRouter.post("/properties/:propertyId/units", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const property = await loadManageableProperty(user, routeParam(request, "propertyId"));
  if (property.listingStatus === "Archived") throw conflict("This property is archived");

  const input = createUnitSchema.parse(request.body);
  await assertUnitNumberFree(property.id, input.unitNumber);

  const unit = await prisma.unit.create({
    data: { ...toUnitData(input), propertyId: property.id, unitNumber: input.unitNumber, unitType: input.unitType, bedrooms: input.bedrooms, bathrooms: input.bathrooms, floorArea: input.floorArea, furnishing: input.furnishing, monthlyRent: input.monthlyRent, features: input.features ?? [] },
    include: { files: true },
  });
  await writeAudit({ request, actorId: user.id, action: "unit.create", entity: "Unit", entityId: unit.id, after: { propertyId: property.id, unitNumber: unit.unitNumber } });
  response.status(201).json(serializeUnit(unit));
});

unitsRouter.get("/properties/:propertyId/units", requireAuth, async (request, response) => {
  const property = await loadManageableProperty(currentUser(request), routeParam(request, "propertyId"));
  const units = await prisma.unit.findMany({ where: { propertyId: property.id }, include: { files: true }, orderBy: { unitNumber: "asc" } });
  response.json(units.map(serializeUnit));
});

unitsRouter.get("/units/:id", requireAuth, async (request, response) => {
  const unit = await loadManageableUnit(currentUser(request), routeParam(request, "id"));
  const full = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id }, include: { files: true } });
  response.json(serializeUnit(full));
});

unitsRouter.patch("/units/:id", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const unit = await loadManageableUnit(user, routeParam(request, "id"));
  const changes = updateUnitSchema.parse(request.body);

  if (changes.unitNumber) await assertUnitNumberFree(unit.propertyId, changes.unitNumber, unit.id);

  const updated = await prisma.unit.update({ where: { id: unit.id }, data: toUnitData(changes), include: { files: true } });
  await writeAudit({ request, actorId: user.id, action: "unit.update", entity: "Unit", entityId: unit.id, after: changes });
  if (user.id !== unit.property.ownerId) {
    await notifyUser({
      userId: unit.property.ownerId,
      type: "unit.edited",
      title: "A unit was edited by an admin",
      message: `An admin updated unit ${updated.unitNumber} of ${unit.property.name}.`,
      link: `/properties/${unit.propertyId}`,
    });
  }
  response.json(serializeUnit(updated));
});

// Occupied is set only by a tenancy; owners and admins can switch between Vacant and Under maintenance.
unitsRouter.patch("/units/:id/status", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const unit = await loadManageableUnit(user, routeParam(request, "id"));
  const { status } = statusSchema.parse(request.body);

  if (unit.status === "Occupied") throw conflict("The unit has an active tenancy. End the tenancy first.");
  if (unit.status === status) throw conflict(`The unit is already ${status}`);

  const updated = await prisma.unit.update({ where: { id: unit.id }, data: { status }, include: { files: true } });
  await writeAudit({ request, actorId: user.id, action: "unit.status", entity: "Unit", entityId: unit.id, before: { status: unit.status }, after: { status } });
  response.json(serializeUnit(updated));
});

unitsRouter.delete("/units/:id", requireAuth, async (request, response) => {
  const user = currentUser(request);
  const unit = await loadManageableUnit(user, routeParam(request, "id"));

  if ((await prisma.tenancy.count({ where: { unitId: unit.id } })) > 0) {
    throw conflict("This unit has tenancy history and cannot be deleted. Set it to Under maintenance instead.");
  }

  const files = await prisma.fileAsset.findMany({ where: { unitId: unit.id } });
  await prisma.unit.delete({ where: { id: unit.id } });
  await removeStoredFiles(...files.flatMap((file) => [file.storagePath, file.thumbPath]));
  await writeAudit({ request, actorId: user.id, action: "unit.delete", entity: "Unit", entityId: unit.id, before: { unitNumber: unit.unitNumber } });
  response.json({ ok: true });
});

unitsRouter.post("/units/:id/photos", requireAuth, uploadLimiter, imageUpload(MAX_UNIT_PHOTOS, 5).array("photos", MAX_UNIT_PHOTOS), async (request, response) => {
  const user = currentUser(request);
  const unit = await loadManageableUnit(user, routeParam(request, "id"));
  const files = (request.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest('Attach images in the "photos" field');

  const existing = await prisma.fileAsset.count({ where: { unitId: unit.id, kind: "unit_photo" } });
  if (existing + files.length > MAX_UNIT_PHOTOS) throw unprocessable(`A unit can have at most ${MAX_UNIT_PHOTOS} photos (it has ${existing})`);

  const created = [];
  for (const [index, file] of files.entries()) {
    const stored = await storeImage(file, `units/${unit.id}`);
    created.push(
      await prisma.fileAsset.create({
        data: {
          kind: "unit_photo",
          unitId: unit.id,
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
  await writeAudit({ request, actorId: user.id, action: "unit.add_photos", entity: "Unit", entityId: unit.id, after: { count: created.length } });
  response.status(201).json(created.map(serializeFile));
});

export default unitsRouter;
