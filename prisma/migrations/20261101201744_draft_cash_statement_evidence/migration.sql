-- CreateTable
CREATE TABLE "draft_cash_evidence" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "asOfDate" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "attested" BOOLEAN NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_cash_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_cash_evidence_balances" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(38,12) NOT NULL,

    CONSTRAINT "draft_cash_evidence_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_cash_evidence_decisions" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_cash_evidence_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "draft_cash_evidence_statementId_asOfDate_recordedAt_idx" ON "draft_cash_evidence"("statementId", "asOfDate", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_evidence_statementId_idempotencyKey_key" ON "draft_cash_evidence"("statementId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_evidence_statementId_asOfDate_idempotencyKey_key" ON "draft_cash_evidence"("statementId", "asOfDate", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_evidence_balances_evidenceId_currency_key" ON "draft_cash_evidence_balances"("evidenceId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "draft_cash_evidence_decisions_evidenceId_currency_key" ON "draft_cash_evidence_decisions"("evidenceId", "currency");

-- AddForeignKey
ALTER TABLE "draft_cash_evidence" ADD CONSTRAINT "draft_cash_evidence_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "account_opening_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_cash_evidence_balances" ADD CONSTRAINT "draft_cash_evidence_balances_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "draft_cash_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_cash_evidence_decisions" ADD CONSTRAINT "draft_cash_evidence_decisions_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "draft_cash_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
