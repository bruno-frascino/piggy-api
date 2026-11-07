-- CreateTable
CREATE TABLE "account_cash_operation_revisions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "previousRevisionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "auditNumber" INTEGER NOT NULL,
    "previousFingerprint" TEXT NOT NULL,
    "nextFingerprint" TEXT NOT NULL,
    "transactionSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_cash_operation_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_cash_revision_postings" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "legIndex" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(38,12) NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "account_cash_revision_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operation_revisions_accountId_id_key" ON "account_cash_operation_revisions"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operation_revisions_accountId_idempotencyKey_key" ON "account_cash_operation_revisions"("accountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operation_revisions_accountId_auditNumber_key" ON "account_cash_operation_revisions"("accountId", "auditNumber");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operation_revisions_operationId_revisionNumber_key" ON "account_cash_operation_revisions"("operationId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_revision_postings_revisionId_legIndex_key" ON "account_cash_revision_postings"("revisionId", "legIndex");

-- AddForeignKey
ALTER TABLE "account_cash_operation_revisions" ADD CONSTRAINT "account_cash_operation_revisions_accountId_operationId_fkey" FOREIGN KEY ("accountId", "operationId") REFERENCES "account_cash_operations"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_cash_operation_revisions" ADD CONSTRAINT "account_cash_operation_revisions_accountId_previousRevisio_fkey" FOREIGN KEY ("accountId", "previousRevisionId") REFERENCES "account_cash_operation_revisions"("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_cash_revision_postings" ADD CONSTRAINT "account_cash_revision_postings_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "account_cash_operation_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
