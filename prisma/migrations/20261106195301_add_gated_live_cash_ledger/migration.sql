-- CreateTable
CREATE TABLE "account_cash_ledgers" (
    "accountId" TEXT NOT NULL,
    "openingStatementId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "openingSourceFingerprint" TEXT NOT NULL,
    "acceptedSourceFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_cash_ledgers_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "account_cash_operations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "sequence" BIGINT NOT NULL,
    "auditNumber" INTEGER NOT NULL,
    "command" JSONB NOT NULL,
    "previousFingerprint" TEXT NOT NULL,
    "nextFingerprint" TEXT NOT NULL,
    "transactionSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_cash_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_cash_postings" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "legIndex" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(38,12) NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "account_cash_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_ledgers_openingStatementId_key" ON "account_cash_ledgers"("openingStatementId");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operations_transactionId_key" ON "account_cash_operations"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operations_accountId_id_key" ON "account_cash_operations"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operations_accountId_idempotencyKey_key" ON "account_cash_operations"("accountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operations_accountId_effectiveDate_sequence_key" ON "account_cash_operations"("accountId", "effectiveDate", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operations_accountId_auditNumber_key" ON "account_cash_operations"("accountId", "auditNumber");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_postings_operationId_legIndex_key" ON "account_cash_postings"("operationId", "legIndex");

-- AddForeignKey
ALTER TABLE "account_cash_ledgers" ADD CONSTRAINT "account_cash_ledgers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_cash_ledgers" ADD CONSTRAINT "account_cash_ledgers_openingStatementId_fkey" FOREIGN KEY ("openingStatementId") REFERENCES "account_opening_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_cash_operations" ADD CONSTRAINT "account_cash_operations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account_cash_ledgers"("accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_cash_operations" ADD CONSTRAINT "account_cash_operations_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_cash_postings" ADD CONSTRAINT "account_cash_postings_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "account_cash_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
