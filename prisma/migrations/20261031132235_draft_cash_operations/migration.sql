-- CreateTable
CREATE TABLE "draft_cash_operations" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "methodology" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "sequence" BIGINT NOT NULL,
    "sourceOrigin" TEXT NOT NULL,
    "sourceReference" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_cash_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_cash_postings" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "legIndex" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(38,12) NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "draft_cash_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_operation_trade_links" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,

    CONSTRAINT "draft_operation_trade_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_operations_statementId_id_key" ON "draft_cash_operations"("statementId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_operations_statementId_idempotencyKey_key" ON "draft_cash_operations"("statementId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_operations_statementId_sourceOrigin_sourceRefere_key" ON "draft_cash_operations"("statementId", "sourceOrigin", "sourceReference");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_operations_statementId_effectiveDate_sequence_key" ON "draft_cash_operations"("statementId", "effectiveDate", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_postings_operationId_legIndex_key" ON "draft_cash_postings"("operationId", "legIndex");

-- CreateIndex
CREATE UNIQUE INDEX "draft_operation_trade_links_statementId_transactionId_key" ON "draft_operation_trade_links"("statementId", "transactionId");

-- AddForeignKey
ALTER TABLE "draft_cash_operations" ADD CONSTRAINT "draft_cash_operations_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "account_opening_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_cash_postings" ADD CONSTRAINT "draft_cash_postings_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "draft_cash_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_operation_trade_links" ADD CONSTRAINT "draft_operation_trade_links_statementId_operationId_fkey" FOREIGN KEY ("statementId", "operationId") REFERENCES "draft_cash_operations"("statementId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
