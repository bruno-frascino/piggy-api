-- AlterTable
ALTER TABLE "account_cash_ledgers" ADD COLUMN     "confirmationAudit" JSONB,
ADD COLUMN     "confirmationIdempotencyKey" TEXT,
ADD COLUMN     "confirmationPayloadHash" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedByUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_ledgers_confirmationIdempotencyKey_key" ON "account_cash_ledgers"("confirmationIdempotencyKey");
