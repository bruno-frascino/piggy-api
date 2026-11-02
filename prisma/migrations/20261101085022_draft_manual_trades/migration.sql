-- CreateTable
CREATE TABLE "draft_manual_trades" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "parcelKey" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,
    "price" DECIMAL(38,12) NOT NULL,
    "fees" DECIMAL(38,12) NOT NULL,
    "requestHash" TEXT NOT NULL,
    "request" JSONB NOT NULL,

    CONSTRAINT "draft_manual_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "draft_manual_trades_operationId_key" ON "draft_manual_trades"("operationId");

-- CreateIndex
CREATE INDEX "draft_manual_trades_parcelKey_idx" ON "draft_manual_trades"("parcelKey");

-- AddForeignKey
ALTER TABLE "draft_manual_trades" ADD CONSTRAINT "draft_manual_trades_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "draft_cash_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
