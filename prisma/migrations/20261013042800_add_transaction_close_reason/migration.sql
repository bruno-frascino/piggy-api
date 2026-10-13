-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('STOP_LOSS', 'TARGET', 'MANUAL', 'OTHER');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "closeReason" "CloseReason";
