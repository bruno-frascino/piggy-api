-- Create trading accounts table
CREATE TABLE "trading_accounts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "exchangeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- Add optional account reference to positions
ALTER TABLE "positions"
ADD COLUMN "accountId" TEXT;

-- Backfill one default account per user+exchange pair from existing positions
INSERT INTO "trading_accounts" (
  "id",
  "userId",
  "exchangeId",
  "name",
  "createdAt",
  "updatedAt"
)
SELECT
  'acc_' || md5(p."userId" || '_' || a."exchangeId" || '_Main'),
  p."userId",
  a."exchangeId",
  'Main',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "positions" p
JOIN "assets" a ON a."id" = p."assetId"
GROUP BY p."userId", a."exchangeId"
ON CONFLICT ("userId", "exchangeId", "name") DO NOTHING;

-- Assign all existing positions to their default account
UPDATE "positions" p
SET "accountId" = ta."id"
FROM "assets" a
JOIN "trading_accounts" ta
  ON ta."userId" = p."userId"
 AND ta."exchangeId" = a."exchangeId"
 AND ta."name" = 'Main'
WHERE a."id" = p."assetId"
  AND p."accountId" IS NULL;

-- Enforce required account on positions
ALTER TABLE "positions"
ALTER COLUMN "accountId" SET NOT NULL;

-- Allow duplicate same-asset entries across different accounts
DROP INDEX IF EXISTS "positions_userId_assetId_openDate_entryPrice_key";

CREATE UNIQUE INDEX "positions_userId_assetId_openDate_entryPrice_accountId_key"
ON "positions"("userId", "assetId", "openDate", "entryPrice", "accountId");

-- Enforce uniqueness per user+exchange+account name
CREATE UNIQUE INDEX "trading_accounts_userId_exchangeId_name_key"
ON "trading_accounts"("userId", "exchangeId", "name");

-- Helpful lookup indexes
CREATE INDEX "trading_accounts_userId_idx"
ON "trading_accounts"("userId");

CREATE INDEX "trading_accounts_exchangeId_idx"
ON "trading_accounts"("exchangeId");

CREATE INDEX "positions_accountId_idx"
ON "positions"("accountId");

-- Foreign keys
ALTER TABLE "trading_accounts"
ADD CONSTRAINT "trading_accounts_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trading_accounts"
ADD CONSTRAINT "trading_accounts_exchangeId_fkey"
FOREIGN KEY ("exchangeId") REFERENCES "exchanges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "positions"
ADD CONSTRAINT "positions_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
