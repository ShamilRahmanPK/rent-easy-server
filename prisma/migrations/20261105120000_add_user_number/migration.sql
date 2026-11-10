-- AlterTable
ALTER TABLE "User" ADD COLUMN     "userNumber" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_userNumber_key" ON "User"("userNumber");

