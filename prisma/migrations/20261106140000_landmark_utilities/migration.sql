-- CreateEnum
CREATE TYPE "Utilities" AS ENUM ('NotIncluded', 'Partly', 'AllIncluded');

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "landmark" TEXT;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "noticePeriodMonths" INTEGER,
ADD COLUMN     "utilities" "Utilities" NOT NULL DEFAULT 'NotIncluded';

