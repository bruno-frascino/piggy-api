-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "purgeAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_purgeAfter_idx" ON "users"("purgeAfter");

-- DropForeignKey
ALTER TABLE "positions" DROP CONSTRAINT "positions_userId_fkey";

-- DropForeignKey
ALTER TABLE "portfolio_snapshots" DROP CONSTRAINT "portfolio_snapshots_userId_fkey";

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
