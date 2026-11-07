-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "voidedAt" TIMESTAMP(3);
