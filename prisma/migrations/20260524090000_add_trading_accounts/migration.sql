-- Create trading accounts table
CREATE TABLE "trading_accounts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- Add optional account reference to positions
ALTER TABLE "positions"
ADD COLUMN "accountId" TEXT;

-- Scope portfolio snapshots by account+exchange for charting
ALTER TABLE "portfolio_snapshots"
ADD COLUMN "accountId" TEXT;

ALTER TABLE "portfolio_snapshots"
ADD COLUMN "exchangeId" TEXT;

-- Backfill one default account per user from existing positions
INSERT INTO "trading_accounts" (
  "id",
  "userId",
  "name",
  "createdAt",
  "updatedAt"
)
SELECT
  'acc_' || md5(p."userId" || '_Main'),
  p."userId",
  'Main',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "positions" p
WHERE NOT EXISTS (
  SELECT 1
  FROM "trading_accounts" ta
  WHERE ta."userId" = p."userId"
    AND ta."name" = 'Main'
)
GROUP BY p."userId"
;

-- Assign all existing positions to their default account
UPDATE "positions" p
SET "accountId" = ta."id"
FROM "trading_accounts" ta
WHERE ta."userId" = p."userId"
  AND ta."name" = 'Main'
  AND p."accountId" IS NULL;

-- Enforce required account on positions
ALTER TABLE "positions"
ALTER COLUMN "accountId" SET NOT NULL;

-- Enforce required account+exchange on snapshots
ALTER TABLE "portfolio_snapshots"
ALTER COLUMN "accountId" SET NOT NULL;

ALTER TABLE "portfolio_snapshots"
ALTER COLUMN "exchangeId" SET NOT NULL;

-- Allow duplicate same-asset entries across different accounts
DROP INDEX IF EXISTS "positions_userId_assetId_openDate_entryPrice_key";

CREATE UNIQUE INDEX "positions_userId_assetId_openDate_entryPrice_accountId_key"
ON "positions"("userId", "assetId", "openDate", "entryPrice", "accountId");

DROP INDEX IF EXISTS "portfolio_snapshots_userId_date_key";

CREATE UNIQUE INDEX "portfolio_snapshots_userId_accountId_exchangeId_date_key"
ON "portfolio_snapshots"("userId", "accountId", "exchangeId", "date");

-- Enforce uniqueness per user+account name
CREATE UNIQUE INDEX "trading_accounts_userId_name_key"
ON "trading_accounts"("userId", "name");

-- Helpful lookup indexes
CREATE INDEX "trading_accounts_userId_idx"
ON "trading_accounts"("userId");

CREATE INDEX "positions_accountId_idx"
ON "positions"("accountId");

CREATE INDEX "portfolio_snapshots_accountId_idx"
ON "portfolio_snapshots"("accountId");

CREATE INDEX "portfolio_snapshots_exchangeId_idx"
ON "portfolio_snapshots"("exchangeId");

-- Foreign keys
ALTER TABLE "trading_accounts"
ADD CONSTRAINT "trading_accounts_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "positions"
ADD CONSTRAINT "positions_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portfolio_snapshots"
ADD CONSTRAINT "portfolio_snapshots_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portfolio_snapshots"
ADD CONSTRAINT "portfolio_snapshots_exchangeId_fkey"
FOREIGN KEY ("exchangeId") REFERENCES "exchanges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
