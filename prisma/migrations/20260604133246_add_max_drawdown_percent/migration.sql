-- DropIndex
DROP INDEX "portfolio_snapshots_accountId_idx";

-- DropIndex
DROP INDEX "portfolio_snapshots_exchangeId_idx";

-- DropIndex
DROP INDEX "positions_accountId_idx";

-- DropIndex
DROP INDEX "positions_assetId_idx";

-- DropIndex
DROP INDEX "positions_userId_idx";

-- DropIndex
DROP INDEX "trading_accounts_userId_idx";

-- DropIndex
DROP INDEX "transactions_positionId_idx";

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "maxDrawdownPercent" DECIMAL(8,4);
