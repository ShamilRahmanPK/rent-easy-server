-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IdType" ADD VALUE 'philsys';
ALTER TYPE "IdType" ADD VALUE 'umid';
ALTER TYPE "IdType" ADD VALUE 'postal_id';
ALTER TYPE "IdType" ADD VALUE 'sss_id';
ALTER TYPE "IdType" ADD VALUE 'voters_id';
ALTER TYPE "IdType" ADD VALUE 'prc_id';

