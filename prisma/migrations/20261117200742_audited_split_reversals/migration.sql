-- DropIndex
DROP INDEX "account_split_actions_accountId_assetId_sourceReference_key";

-- DropIndex
DROP INDEX "account_split_actions_accountId_assetId_effectiveDate_key";

-- CreateTable
CREATE TABLE "account_split_reversals" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "auditNumber" INTEGER NOT NULL,
    "previousFingerprint" TEXT NOT NULL,
    "nextFingerprint" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_split_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_split_reversals_actionId_key" ON "account_split_reversals"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_reversals_accountId_id_key" ON "account_split_reversals"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_reversals_accountId_actionId_key" ON "account_split_reversals"("accountId", "actionId");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_reversals_accountId_idempotencyKey_key" ON "account_split_reversals"("accountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_reversals_accountId_auditNumber_key" ON "account_split_reversals"("accountId", "auditNumber");

-- CreateIndex
CREATE INDEX "account_split_actions_accountId_assetId_sourceReference_idx" ON "account_split_actions"("accountId", "assetId", "sourceReference");

-- CreateIndex
CREATE INDEX "account_split_actions_accountId_assetId_effectiveDate_idx" ON "account_split_actions"("accountId", "assetId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_actions_accountId_id_key" ON "account_split_actions"("accountId", "id");

-- AddForeignKey
ALTER TABLE "account_split_reversals" ADD CONSTRAINT "account_split_reversals_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_split_reversals" ADD CONSTRAINT "account_split_reversals_accountId_actionId_fkey" FOREIGN KEY ("accountId", "actionId") REFERENCES "account_split_actions"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
