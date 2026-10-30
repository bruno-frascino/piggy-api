
-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('KRAKEN', 'BINANCE', 'COINBASE');

-- CreateEnum
CREATE TYPE "ImportMethod" AS ENUM ('CSV', 'API');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING_REVIEW', 'PARTIALLY_APPLIED', 'COMMITTED', 'DISCARDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportedEventKind" AS ENUM ('BUY', 'SELL', 'STAKING_REWARD', 'DEPOSIT', 'WITHDRAWAL', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ImportedEventStatus" AS ENUM ('PENDING', 'DEFERRED', 'APPLIED', 'SKIPPED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "method" "ImportMethod" NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "fileNames" TEXT[],
    "fileHash" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_events" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" "ImportedEventKind" NOT NULL,
    "status" "ImportedEventStatus" NOT NULL DEFAULT 'PENDING',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "baseAsset" TEXT NOT NULL,
    "quoteCurrency" TEXT,
    "exchangeCode" TEXT,
    "quantity" DECIMAL(28,12) NOT NULL,
    "price" DECIMAL(24,12),
    "grossValue" DECIMAL(20,8),
    "fee" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "feeCurrency" TEXT,
    "fmvAud" DECIMAL(20,8),
    "resolution" JSONB,
    "appliedPositionIds" TEXT[],
    "warning" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imported_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_userId_createdAt_idx" ON "import_batches"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "imported_events_userId_kind_status_idx" ON "imported_events"("userId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "imported_events_userId_source_externalId_key" ON "imported_events"("userId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_events" ADD CONSTRAINT "imported_events_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

