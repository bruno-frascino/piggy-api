-- Truffles — consolidated v1 init migration
-- All schema changes up to 2026-05-27 collapsed into a single script.
-- Use `prisma migrate reset` to apply from scratch.

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "AssetType"       AS ENUM ('EQUITY', 'ETF', 'CRYPTO');
CREATE TYPE "TradingAccountStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "PositionType"    AS ENUM ('LONG', 'SHORT');
CREATE TYPE "PositionStatus"  AS ENUM ('OPEN', 'CLOSED', 'PARTIAL');
CREATE TYPE "TransactionType" AS ENUM ('BUY', 'SELL', 'DIVIDEND', 'SPLIT', 'BONUS');

-- ─── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE "users" (
    "id"           TEXT        NOT NULL,
    "email"        TEXT        NOT NULL,
    "name"         TEXT,
    "passwordHash" TEXT        NOT NULL,
    "baseCurrency" TEXT        NOT NULL DEFAULT 'AUD',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_tokens" (
    "id"        TEXT        NOT NULL,
    "userId"    TEXT        NOT NULL,
    "token"     TEXT        NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_reset_tokens" (
    "id"        TEXT        NOT NULL,
    "userId"    TEXT        NOT NULL,
    "token"     TEXT        NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exchanges" (
    "id"           TEXT        NOT NULL,
    "code"         TEXT        NOT NULL,
    "name"         TEXT        NOT NULL,
    "currency"     TEXT        NOT NULL DEFAULT 'USD',
    "countryName"  TEXT        NOT NULL,
    "countryCode"  TEXT        NOT NULL,
    "symbolSuffix" TEXT,
    "delay"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exchanges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "trading_accounts" (
    "id"        TEXT        NOT NULL,
    "userId"    TEXT        NOT NULL,
    "name"      TEXT        NOT NULL,
    "status"    "TradingAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "closedAt"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assets" (
    "id"         TEXT           NOT NULL,
    "symbol"     TEXT           NOT NULL,
    "name"       TEXT           NOT NULL,
    "assetType"  "AssetType"    NOT NULL DEFAULT 'EQUITY',
    "sector"     TEXT,
    "industry"   TEXT,
    "marketCap"  DECIMAL(20,2),
    "exchangeId" TEXT           NOT NULL,
    "isActive"   BOOLEAN        NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3)   NOT NULL,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "price_history" (
    "id"        TEXT         NOT NULL,
    "assetId"   TEXT         NOT NULL,
    "date"      TIMESTAMP(3) NOT NULL,
    "open"      DECIMAL(10,4) NOT NULL,
    "high"      DECIMAL(10,4) NOT NULL,
    "low"       DECIMAL(10,4) NOT NULL,
    "close"     DECIMAL(10,4) NOT NULL,
    "volume"    BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "positions" (
    "id"               TEXT             NOT NULL,
    "userId"           TEXT             NOT NULL,
    "assetId"          TEXT             NOT NULL,
    "accountId"        TEXT             NOT NULL,
    "openDate"         TIMESTAMP(3)     NOT NULL,
    "entryPrice"       DECIMAL(10,4)    NOT NULL,
    "quantity"         DOUBLE PRECISION NOT NULL,
    "positionType"     "PositionType"   NOT NULL DEFAULT 'LONG',
    "status"           "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "totalBuyValue"    DECIMAL(12,2)    NOT NULL,
    "buyFees"          DECIMAL(8,2)     NOT NULL DEFAULT 0,
    "closeDate"        TIMESTAMP(3),
    "exitPrice"        DECIMAL(10,4),
    "totalSellValue"   DECIMAL(12,2),
    "sellFees"         DECIMAL(8,2)     DEFAULT 0,
    "stopLossPrice"    DECIMAL(10,4),
    "takeProfitPrice"  DECIMAL(10,4),
    "riskAmount"       DECIMAL(12,2),
    "riskPercentage"   DECIMAL(5,2),
    "capitalAllocated" DECIMAL(12,2)    NOT NULL,
    "portfolioWeight"  DECIMAL(5,2),
    "openReason"       TEXT             NOT NULL,
    "strategy"         TEXT,
    "setupType"        TEXT,
    "timeframe"        TEXT,
    "tags"             TEXT[],
    "notes"            TEXT,
    "unrealizedPnL"    DECIMAL(12,2),
    "realizedPnL"      DECIMAL(12,2),
    "returnPercentage" DECIMAL(8,4),
    "tradeGrade"       TEXT,
    "lessonsLearned"   TEXT,
    "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)     NOT NULL,
    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transactions" (
    "id"            TEXT               NOT NULL,
    "positionId"    TEXT               NOT NULL,
    "type"          "TransactionType"  NOT NULL,
    "date"          TIMESTAMP(3)       NOT NULL,
    "quantity"      DOUBLE PRECISION   NOT NULL,
    "price"         DECIMAL(10,4)      NOT NULL,
    "totalValue"    DECIMAL(12,2)      NOT NULL,
    "fees"          DECIMAL(8,2)       NOT NULL DEFAULT 0,
    "executionTime" TIMESTAMP(3),
    "brokerRef"     TEXT,
    "orderType"     TEXT,
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)       NOT NULL,
    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "portfolio_snapshots" (
    "id"             TEXT         NOT NULL,
    "userId"         TEXT         NOT NULL,
    "accountId"      TEXT         NOT NULL,
    "exchangeId"     TEXT         NOT NULL,
    "date"           TIMESTAMP(3) NOT NULL,
    "totalValue"     DECIMAL(15,2) NOT NULL,
    "totalInvested"  DECIMAL(15,2) NOT NULL,
    "totalPnL"       DECIMAL(15,2) NOT NULL,
    "totalReturnPct" DECIMAL(8,4)  NOT NULL,
    "portfolioRisk"  DECIMAL(8,4),
    "maxDrawdown"    DECIMAL(8,4),
    "sharpeRatio"    DECIMAL(8,4),
    "availableCash"  DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- ─── Unique indexes ───────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "users_email_key"
    ON "users"("email");

CREATE UNIQUE INDEX "refresh_tokens_token_key"
    ON "refresh_tokens"("token");

CREATE UNIQUE INDEX "password_reset_tokens_token_key"
    ON "password_reset_tokens"("token");

CREATE UNIQUE INDEX "exchanges_code_key"
    ON "exchanges"("code");

CREATE UNIQUE INDEX "trading_accounts_userId_name_key"
    ON "trading_accounts"("userId", "name");

CREATE UNIQUE INDEX "assets_symbol_exchangeId_key"
    ON "assets"("symbol", "exchangeId");

CREATE UNIQUE INDEX "price_history_assetId_date_key"
    ON "price_history"("assetId", "date");

CREATE UNIQUE INDEX "positions_userId_assetId_openDate_entryPrice_accountId_key"
    ON "positions"("userId", "assetId", "openDate", "entryPrice", "accountId");

CREATE UNIQUE INDEX "portfolio_snapshots_userId_accountId_exchangeId_date_key"
    ON "portfolio_snapshots"("userId", "accountId", "exchangeId", "date");

-- ─── Lookup indexes ───────────────────────────────────────────────────────────

CREATE INDEX "trading_accounts_userId_idx"       ON "trading_accounts"("userId");
CREATE INDEX "positions_userId_idx"               ON "positions"("userId");
CREATE INDEX "positions_assetId_idx"              ON "positions"("assetId");
CREATE INDEX "positions_accountId_idx"            ON "positions"("accountId");
CREATE INDEX "transactions_positionId_idx"        ON "transactions"("positionId");
CREATE INDEX "portfolio_snapshots_accountId_idx"  ON "portfolio_snapshots"("accountId");
CREATE INDEX "portfolio_snapshots_exchangeId_idx" ON "portfolio_snapshots"("exchangeId");

-- ─── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trading_accounts"
    ADD CONSTRAINT "trading_accounts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assets"
    ADD CONSTRAINT "assets_exchangeId_fkey"
    FOREIGN KEY ("exchangeId") REFERENCES "exchanges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "price_history"
    ADD CONSTRAINT "price_history_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

ALTER TABLE "portfolio_snapshots"
    ADD CONSTRAINT "portfolio_snapshots_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portfolio_snapshots"
    ADD CONSTRAINT "portfolio_snapshots_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portfolio_snapshots"
    ADD CONSTRAINT "portfolio_snapshots_exchangeId_fkey"
    FOREIGN KEY ("exchangeId") REFERENCES "exchanges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
