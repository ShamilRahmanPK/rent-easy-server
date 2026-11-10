import type { FileAsset, Property, Unit, User } from "@prisma/client";
import { serializeFile } from "../services/files.js";
import { formatPropertyCode, formatUnitCode, formatUserCode } from "./formatCode.js";
import { money } from "./serializers.js";

const byDisplayOrder = (a: FileAsset, b: FileAsset) =>
  Number(b.isCover) - Number(a.isCover) || a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();

export const photosOf = (files: FileAsset[] | undefined, kind: "property_photo" | "unit_photo") =>
  (files ?? []).filter((file) => file.kind === kind).sort(byDisplayOrder).map(serializeFile);

export type UnitWithFiles = Unit & { files?: FileAsset[] };
export type PropertyWithRelations = Property & {
  files?: FileAsset[];
  units?: UnitWithFiles[];
  owner?: Pick<User, "id" | "userNumber" | "fullName" | "email">;
  _count?: { units: number };
};

export function serializeUnit(unit: UnitWithFiles) {
  const photos = photosOf(unit.files, "unit_photo");
  return {
    id: unit.id,
    code: formatUnitCode(unit.unitSerial),
    propertyId: unit.propertyId,
    unitNumber: unit.unitNumber,
    floor: unit.floor,
    unitType: unit.unitType,
    bedrooms: unit.bedrooms,
    bathrooms: money(unit.bathrooms),
    floorArea: money(unit.floorArea),
    furnishing: unit.furnishing,
    monthlyRent: money(unit.monthlyRent),
    securityDeposit: money(unit.securityDeposit),
    minLeaseMonths: unit.minLeaseMonths,
    noticePeriodMonths: unit.noticePeriodMonths,
    utilities: unit.utilities,
    availableFrom: unit.availableFrom ? unit.availableFrom.toISOString().slice(0, 10) : null,
    petsAllowed: unit.petsAllowed,
    smokingAllowed: unit.smokingAllowed,
    features: unit.features,
    description: unit.description,
    status: unit.status,
    photos,
    coverPhoto: photos[0] ?? null,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

// Ownership documents are private, so they are listed only when the caller may see them.
export function serializeProperty(property: PropertyWithRelations, options: { includeDocuments?: boolean; includeOwner?: boolean } = {}) {
  const photos = photosOf(property.files, "property_photo");
  return {
    id: property.id,
    code: formatPropertyCode(property.propertyNumber),
    name: property.name,
    propertyType: property.propertyType,
    description: property.description,
    address: {
      street: property.streetAddress,
      city: property.city,
      province: property.province,
      postalCode: property.postalCode,
      landmark: property.landmark,
      country: property.country,
    },
    location: property.latitude !== null && property.longitude !== null ? { latitude: property.latitude, longitude: property.longitude } : null,
    yearBuilt: property.yearBuilt,
    totalFloors: property.totalFloors,
    parkingSlots: property.parkingSlots,
    amenities: property.amenities,
    totalUnits: property._count?.units ?? property.units?.length ?? 0,
    ownerId: property.ownerId,
    ...(options.includeOwner && property.owner
      ? { owner: { id: property.owner.id, userId: formatUserCode(property.owner.userNumber), fullName: property.owner.fullName, email: property.owner.email } }
      : {}),
    approvalStatus: property.approvalStatus,
    rejectionReason: property.rejectionReason,
    submittedAt: property.submittedAt,
    reviewedAt: property.reviewedAt,
    listingStatus: property.listingStatus,
    photos,
    coverPhoto: photos[0] ?? null,
    ...(options.includeDocuments
      ? { documents: (property.files ?? []).filter((file) => file.kind === "ownership_document").map(serializeFile) }
      : {}),
    ...(property.units ? { units: property.units.map(serializeUnit) } : {}),
    createdAt: property.createdAt,
    updatedAt: property.updatedAt,
  };
}
