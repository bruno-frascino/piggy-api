-- CreateEnum
CREATE TYPE "PositionOrigin" AS ENUM ('MANUAL', 'IMPORT_TRADE', 'STAKING_REWARD');

-- DropIndex
DROP INDEX "positions_userId_assetId_openDate_entryPrice_accountId_key";

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "externalRef" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "origin" "PositionOrigin" NOT NULL DEFAULT 'MANUAL',
ALTER COLUMN "entryPrice" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "buyFees" SET DATA TYPE DECIMAL(18,8),
ALTER COLUMN "exitPrice" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "sellFees" SET DATA TYPE DECIMAL(18,8),
ALTER COLUMN "stopLossPrice" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "takeProfitPrice" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "price_history" ALTER COLUMN "open" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "high" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "low" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "close" SET DATA TYPE DECIMAL(24,12);

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "price" SET DATA TYPE DECIMAL(24,12),
ALTER COLUMN "fees" SET DATA TYPE DECIMAL(18,8);

-- CreateIndex
CREATE UNIQUE INDEX "positions_userId_assetId_openDate_entryPrice_accountId_exte_key" ON "positions"("userId", "assetId", "openDate", "entryPrice", "accountId", "externalRef");
