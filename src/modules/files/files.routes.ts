import { Router } from "express";
import { writeAudit } from "../../lib/audit.js";
import { routeParam } from "../../lib/http.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { currentUser, isStaff, requireAuth, type AuthUser } from "../../middleware/auth.js";
import { removeStoredFiles, resolveStoredPath, serializeFile } from "../../services/files.js";
import { MIN_PROPERTY_PHOTOS } from "../../services/propertyAccess.js";

const filesRouter = Router();
filesRouter.use(requireAuth);

async function loadAccessibleFile(user: AuthUser, fileId: string) {
  const asset = await prisma.fileAsset.findUnique({
    where: { id: fileId },
    include: { property: { select: { ownerId: true, submittedAt: true, approvalStatus: true, listingStatus: true } }, unit: { select: { property: { select: { ownerId: true, approvalStatus: true, listingStatus: true } } } } },
  });
  if (!asset) throw notFound("File not found");

  const ownerId = asset.property?.ownerId ?? asset.unit?.property.ownerId ?? asset.userId;
  if (!isStaff(user) && ownerId !== user.id) throw notFound("File not found");
  return asset;
}

filesRouter.get("/:id/download", async (request, response) => {
  const asset = await loadAccessibleFile(currentUser(request), routeParam(request, "id"));
  response.setHeader("Cache-Control", "private, no-store");
  response.download(resolveStoredPath(asset.storagePath), asset.originalName);
});

filesRouter.patch("/:id/cover", async (request, response) => {
  const user = currentUser(request);
  const asset = await loadAccessibleFile(user, routeParam(request, "id"));
  if (asset.kind !== "property_photo" && asset.kind !== "unit_photo") throw badRequest("Only photos can be the cover");

  const scope = asset.propertyId ? { propertyId: asset.propertyId } : { unitId: asset.unitId };
  await prisma.$transaction([
    prisma.fileAsset.updateMany({ where: { ...scope, kind: asset.kind }, data: { isCover: false } }),
    prisma.fileAsset.update({ where: { id: asset.id }, data: { isCover: true } }),
  ]);
  await writeAudit({ request, actorId: user.id, action: "file.set_cover", entity: "FileAsset", entityId: asset.id });
  response.json(serializeFile(await prisma.fileAsset.findUniqueOrThrow({ where: { id: asset.id } })));
});

filesRouter.delete("/:id", async (request, response) => {
  const user = currentUser(request);
  const asset = await loadAccessibleFile(user, routeParam(request, "id"));
  if (asset.kind === "avatar" || asset.kind === "id_document") throw badRequest("Upload a new file to replace this one");

  const siblingScope = asset.propertyId ? { propertyId: asset.propertyId } : { unitId: asset.unitId };
  const siblings = await prisma.fileAsset.count({ where: { ...siblingScope, kind: asset.kind, id: { not: asset.id } } });

  if (asset.kind === "property_photo" && asset.property?.submittedAt && siblings < MIN_PROPERTY_PHOTOS) {
    throw conflict(`A submitted property needs at least ${MIN_PROPERTY_PHOTOS} photos`);
  }
  if (asset.kind === "ownership_document" && asset.property?.submittedAt && siblings === 0) {
    throw conflict("A submitted property needs at least one ownership document");
  }
  if (asset.kind === "unit_photo" && asset.unit?.property.listingStatus === "Listed" && siblings === 0) {
    throw conflict("A listed unit needs at least one photo");
  }

  await prisma.fileAsset.delete({ where: { id: asset.id } });
  await removeStoredFiles(asset.storagePath, asset.thumbPath);

  // If the cover was removed, the next photo becomes the cover.
  if (asset.isCover) {
    const next = await prisma.fileAsset.findFirst({ where: { ...siblingScope, kind: asset.kind }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    if (next) await prisma.fileAsset.update({ where: { id: next.id }, data: { isCover: true } });
  }
  await writeAudit({ request, actorId: user.id, action: "file.delete", entity: "FileAsset", entityId: asset.id, before: { kind: asset.kind } });
  response.json({ ok: true });
});

export default filesRouter;
