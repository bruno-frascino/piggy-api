-- CreateTable
CREATE TABLE "account_opening_statements" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "openingDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceFingerprint" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "previewSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_opening_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_cash_balances" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(38,12) NOT NULL,

    CONSTRAINT "opening_cash_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_parcel_balances" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,

    CONSTRAINT "opening_parcel_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_opening_statements_accountId_version_key" ON "account_opening_statements"("accountId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "account_opening_statements_accountId_sourceFingerprint_key" ON "account_opening_statements"("accountId", "sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "opening_cash_balances_statementId_currency_key" ON "opening_cash_balances"("statementId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "opening_parcel_balances_statementId_positionId_key" ON "opening_parcel_balances"("statementId", "positionId");

-- AddForeignKey
ALTER TABLE "account_opening_statements" ADD CONSTRAINT "account_opening_statements_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_cash_balances" ADD CONSTRAINT "opening_cash_balances_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "account_opening_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_parcel_balances" ADD CONSTRAINT "opening_parcel_balances_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "account_opening_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
