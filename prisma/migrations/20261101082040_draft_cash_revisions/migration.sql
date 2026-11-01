-- CreateTable
CREATE TABLE "draft_cash_revisions" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "previousRevisionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_cash_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_cash_revision_postings" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "legIndex" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(38,12) NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "draft_cash_revision_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_revisions_operationId_id_key" ON "draft_cash_revisions"("operationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_revisions_operationId_revisionNumber_key" ON "draft_cash_revisions"("operationId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_revisions_statementId_idempotencyKey_key" ON "draft_cash_revisions"("statementId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_revision_postings_revisionId_legIndex_key" ON "draft_cash_revision_postings"("revisionId", "legIndex");

-- AddForeignKey
ALTER TABLE "draft_cash_revisions" ADD CONSTRAINT "draft_cash_revisions_statementId_operationId_fkey" FOREIGN KEY ("statementId", "operationId") REFERENCES "draft_cash_operations"("statementId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_cash_revisions" ADD CONSTRAINT "draft_cash_revisions_operationId_previousRevisionId_fkey" FOREIGN KEY ("operationId", "previousRevisionId") REFERENCES "draft_cash_revisions"("operationId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "draft_cash_revision_postings" ADD CONSTRAINT "draft_cash_revision_postings_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "draft_cash_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
