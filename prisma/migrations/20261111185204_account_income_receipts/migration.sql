-- CreateTable
CREATE TABLE "account_income_receipts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "entitlementDate" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "grossAmount" DECIMAL(38,12) NOT NULL,
    "withholdingAmount" DECIMAL(38,12) NOT NULL,
    "frankedAmount" DECIMAL(38,12) NOT NULL,
    "unfrankedAmount" DECIMAL(38,12) NOT NULL,
    "frankingCreditAud" DECIMAL(38,12) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_income_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_income_receipts_operationId_key" ON "account_income_receipts"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "account_income_receipts_accountId_operationId_key" ON "account_income_receipts"("accountId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "account_income_receipts_accountId_id_key" ON "account_income_receipts"("accountId", "id");

-- AddForeignKey
ALTER TABLE "account_income_receipts" ADD CONSTRAINT "account_income_receipts_accountId_operationId_fkey" FOREIGN KEY ("accountId", "operationId") REFERENCES "account_cash_operations"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_income_receipts" ADD CONSTRAINT "account_income_receipts_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
