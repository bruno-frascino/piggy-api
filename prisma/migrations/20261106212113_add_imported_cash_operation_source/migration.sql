-- AlterTable
ALTER TABLE "account_cash_operations" ADD COLUMN "importedEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "account_cash_operations_importedEventId_key"
ON "account_cash_operations"("importedEventId");

-- AddForeignKey
ALTER TABLE "account_cash_operations"
ADD CONSTRAINT "account_cash_operations_importedEventId_fkey"
FOREIGN KEY ("importedEventId") REFERENCES "imported_events"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
