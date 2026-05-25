-- Clean rebuild for fractional position quantities
-- This migration is destructive on the affected tables and is intended for a non-production database.

DROP TABLE IF EXISTS "transactions";
DROP TABLE IF EXISTS "positions";

CREATE TABLE "positions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "openDate" TIMESTAMP(3) NOT NULL,
  "entryPrice" DECIMAL(10,4) NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "positionType" "PositionType" NOT NULL DEFAULT 'LONG',
  "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
  "totalBuyValue" DECIMAL(12,2) NOT NULL,
  "buyFees" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "closeDate" TIMESTAMP(3),
  "exitPrice" DECIMAL(10,4),
  "totalSellValue" DECIMAL(12,2),
  "sellFees" DECIMAL(8,2) DEFAULT 0,
  "stopLossPrice" DECIMAL(10,4),
  "takeProfitPrice" DECIMAL(10,4),
  "riskAmount" DECIMAL(12,2),
  "riskPercentage" DECIMAL(5,2),
  "capitalAllocated" DECIMAL(12,2) NOT NULL,
  "portfolioWeight" DECIMAL(5,2),
  "openReason" TEXT NOT NULL,
  "strategy" TEXT,
  "setupType" TEXT,
  "timeframe" TEXT,
  "tags" TEXT[],
  "notes" TEXT,
  "unrealizedPnL" DECIMAL(12,2),
  "realizedPnL" DECIMAL(12,2),
  "returnPercentage" DECIMAL(8,4),
  "tradeGrade" TEXT,
  "lessonsLearned" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transactions" (
  "id" TEXT NOT NULL,
  "positionId" TEXT NOT NULL,
  "type" "TransactionType" NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "price" DECIMAL(10,4) NOT NULL,
  "totalValue" DECIMAL(12,2) NOT NULL,
  "fees" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "executionTime" TIMESTAMP(3),
  "brokerRef" TEXT,
  "orderType" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "positions_userId_assetId_openDate_entryPrice_accountId_key"
ON "positions"("userId", "assetId", "openDate", "entryPrice", "accountId");

CREATE INDEX "positions_accountId_idx"
ON "positions"("accountId");

CREATE INDEX "positions_assetId_idx"
ON "positions"("assetId");

CREATE INDEX "positions_userId_idx"
ON "positions"("userId");

CREATE INDEX "transactions_positionId_idx"
ON "transactions"("positionId");

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
