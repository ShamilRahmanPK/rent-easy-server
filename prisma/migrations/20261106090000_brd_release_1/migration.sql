-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('Active', 'Suspended', 'Deactivated');

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('passport', 'national_id', 'emirates_id', 'driving_license', 'other');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('apartment_building', 'condominium', 'house', 'townhouse', 'commercial');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('Pending', 'Approved', 'Rejected');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('Draft', 'Listed', 'Hidden', 'Archived');

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('studio', 'one_bedroom', 'two_bedroom', 'three_bedroom', 'house', 'room');

-- CreateEnum
CREATE TYPE "Furnishing" AS ENUM ('Unfurnished', 'SemiFurnished', 'FullyFurnished');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('Vacant', 'Occupied', 'UnderMaintenance');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('property_photo', 'unit_photo', 'ownership_document', 'avatar', 'id_document');

-- CreateEnum
CREATE TYPE "TenancyStatus" AS ENUM ('Active', 'Ended');

-- CreateEnum
CREATE TYPE "RentRequestStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Cancelled');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('email_verify', 'password_reset');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('Queued', 'Sent', 'Failed');


-- AlterTable
ALTER TABLE "Property" DROP COLUMN "address",
DROP COLUMN "status",
ADD COLUMN     "amenities" TEXT[],
ADD COLUMN     "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'Pending',
ADD COLUMN     "city" TEXT NOT NULL,
ADD COLUMN     "country" TEXT NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "parkingSlots" INTEGER,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "propertyNumber" SERIAL NOT NULL,
ADD COLUMN     "propertyType" "PropertyType" NOT NULL,
ADD COLUMN     "province" TEXT NOT NULL,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "streetAddress" TEXT NOT NULL,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "totalFloors" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "yearBuilt" INTEGER,
DROP COLUMN "listingStatus",
ADD COLUMN     "listingStatus" "ListingStatus" NOT NULL DEFAULT 'Draft';

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "availableFrom" DATE,
ADD COLUMN     "bathrooms" DECIMAL(3,1) NOT NULL,
ADD COLUMN     "bedrooms" INTEGER NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "features" TEXT[],
ADD COLUMN     "floor" INTEGER,
ADD COLUMN     "floorArea" DECIMAL(8,2) NOT NULL,
ADD COLUMN     "furnishing" "Furnishing" NOT NULL,
ADD COLUMN     "minLeaseMonths" INTEGER,
ADD COLUMN     "petsAllowed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "securityDeposit" DECIMAL(12,2),
ADD COLUMN     "smokingAllowed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unitSerial" SERIAL NOT NULL,
ADD COLUMN     "unitType" "UnitType" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "UnitStatus" NOT NULL DEFAULT 'Vacant';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstFailedLoginAt" TIMESTAMP(3),
ADD COLUMN     "idDocumentFileId" TEXT,
ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "idType" "IdType",
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "notifyEmailUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyInApp" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "status" "AccountStatus" NOT NULL DEFAULT 'Active',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "userAgent" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "kind" "FileKind" NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "storagePath" TEXT NOT NULL,
    "thumbPath" TEXT,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "isCover" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "propertyId" TEXT,
    "unitId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenancy" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" "TenancyStatus" NOT NULL DEFAULT 'Active',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentRequest" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT,
    "status" "RentRequestStatus" NOT NULL DEFAULT 'Pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "sentById" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailJob" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" "MailStatus" NOT NULL DEFAULT 'Queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRole_role_idx" ON "UserRole"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_type_createdAt_idx" ON "AuthToken"("userId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoginDevice_userId_fingerprint_key" ON "LoginDevice"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "FileAsset_propertyId_kind_idx" ON "FileAsset"("propertyId", "kind");

-- CreateIndex
CREATE INDEX "FileAsset_unitId_kind_idx" ON "FileAsset"("unitId", "kind");

-- CreateIndex
CREATE INDEX "FileAsset_userId_kind_idx" ON "FileAsset"("userId", "kind");

-- CreateIndex
CREATE INDEX "Tenancy_tenantId_status_idx" ON "Tenancy"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Tenancy_unitId_status_idx" ON "Tenancy"("unitId", "status");

-- CreateIndex
CREATE INDEX "RentRequest_status_createdAt_idx" ON "RentRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RentRequest_userId_idx" ON "RentRequest"("userId");

-- CreateIndex
CREATE INDEX "RentRequest_unitId_status_idx" ON "RentRequest"("unitId", "status");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "MailJob_status_runAt_idx" ON "MailJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "MailJob_toEmail_template_createdAt_idx" ON "MailJob"("toEmail", "template", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Property_propertyNumber_key" ON "Property"("propertyNumber");

-- CreateIndex
CREATE INDEX "Property_ownerId_idx" ON "Property"("ownerId");

-- CreateIndex
CREATE INDEX "Property_approvalStatus_submittedAt_idx" ON "Property"("approvalStatus", "submittedAt");

-- CreateIndex
CREATE INDEX "Property_listingStatus_city_idx" ON "Property"("listingStatus", "city");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_unitSerial_key" ON "Unit"("unitSerial");

-- CreateIndex
CREATE INDEX "Unit_status_monthlyRent_idx" ON "Unit"("status", "monthlyRent");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginDevice" ADD CONSTRAINT "LoginDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentRequest" ADD CONSTRAINT "RentRequest_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentRequest" ADD CONSTRAINT "RentRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentRequest" ADD CONSTRAINT "RentRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data migration: one role column becomes many UserRole rows.
-- landlord and property_manager are merged into admin; every account keeps the base "user" role.
INSERT INTO "UserRole" ("userId", "role")
SELECT "id", (CASE "role"::text WHEN 'landlord' THEN 'admin' WHEN 'property_manager' THEN 'admin' ELSE "role"::text END)::"Role"
FROM "User"
ON CONFLICT DO NOTHING;

INSERT INTO "UserRole" ("userId", "role")
SELECT "id", 'user'::"Role" FROM "User"
ON CONFLICT DO NOTHING;

-- Accounts that existed before email verification was introduced count as verified.
UPDATE "User" SET "emailVerified" = true;

ALTER TABLE "User" DROP COLUMN "role";

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('user', 'tenant', 'owner', 'admin', 'super_admin');
ALTER TABLE "UserRole" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
COMMIT;

-- Business rules Prisma cannot express in schema.prisma
CREATE UNIQUE INDEX "Tenancy_one_active_per_unit" ON "Tenancy"("unitId") WHERE "status" = 'Active';
CREATE UNIQUE INDEX "RentRequest_one_pending_per_user_unit" ON "RentRequest"("userId", "unitId") WHERE "status" = 'Pending';
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_bedrooms_nonneg" CHECK ("bedrooms" >= 0);
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_rent_positive" CHECK ("monthlyRent" > 0);
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_area_positive" CHECK ("floorArea" > 0);
