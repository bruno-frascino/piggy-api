-- CreateTable
CREATE TABLE "tax_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "financialYearStartYear" INTEGER NOT NULL,
    "financialYearLabel" TEXT NOT NULL,
    "accountIds" JSONB NOT NULL,
    "accountsKey" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalProceedsAud" DECIMAL(15,2) NOT NULL,
    "totalCostBaseAud" DECIMAL(15,2) NOT NULL,
    "totalCapitalGainGrossAud" DECIMAL(15,2) NOT NULL,
    "totalCapitalLossAud" DECIMAL(15,2) NOT NULL,
    "carriedForwardLossOpeningAud" DECIMAL(15,2) NOT NULL,
    "discountAppliedAud" DECIMAL(15,2) NOT NULL,
    "netCapitalGainAud" DECIMAL(15,2) NOT NULL,
    "carriedForwardLossClosingAud" DECIMAL(15,2) NOT NULL,
    "lineItems" JSONB NOT NULL,
    "pdfData" BYTEA NOT NULL,
    "pdfSizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate_cache" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "rateToAud" DECIMAL(12,6) NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rate_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_reports_userId_financialYearStartYear_accountsKey_key" ON "tax_reports"("userId", "financialYearStartYear", "accountsKey");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_cache_currency_date_key" ON "fx_rate_cache"("currency", "date");

-- AddForeignKey
ALTER TABLE "tax_reports" ADD CONSTRAINT "tax_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
