-- DropIndex
DROP INDEX "tax_reports_userId_financialYearStartYear_accountsKey_key";

-- AlterTable
ALTER TABLE "tax_reports" ADD COLUMN     "contentHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "tax_reports_revision_key" ON "tax_reports"("userId", "financialYearStartYear", "accountsKey", "version");

-- CreateIndex
CREATE INDEX "tax_reports_current_revision_idx" ON "tax_reports"("userId", "financialYearStartYear", "accountsKey", "supersededAt");
