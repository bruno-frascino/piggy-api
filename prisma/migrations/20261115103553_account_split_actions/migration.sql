-- CreateTable
CREATE TABLE "account_split_actions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "newUnits" DECIMAL(26,0) NOT NULL,
    "oldUnits" DECIMAL(26,0) NOT NULL,
    "sourceReference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "methodology" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_split_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_split_parcel_effects" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "beforeQuantity" DECIMAL(38,12) NOT NULL,
    "afterQuantity" DECIMAL(38,12) NOT NULL,

    CONSTRAINT "account_split_parcel_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_split_actions_accountId_effectiveDate_idx" ON "account_split_actions"("accountId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_actions_accountId_idempotencyKey_key" ON "account_split_actions"("accountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_actions_accountId_assetId_sourceReference_key" ON "account_split_actions"("accountId", "assetId", "sourceReference");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_actions_accountId_assetId_effectiveDate_key" ON "account_split_actions"("accountId", "assetId", "effectiveDate");

-- CreateIndex
CREATE INDEX "account_split_parcel_effects_positionId_idx" ON "account_split_parcel_effects"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "account_split_parcel_effects_actionId_positionId_key" ON "account_split_parcel_effects"("actionId", "positionId");

-- AddForeignKey
ALTER TABLE "account_split_actions" ADD CONSTRAINT "account_split_actions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_split_actions" ADD CONSTRAINT "account_split_actions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_split_parcel_effects" ADD CONSTRAINT "account_split_parcel_effects_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "account_split_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_split_parcel_effects" ADD CONSTRAINT "account_split_parcel_effects_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
