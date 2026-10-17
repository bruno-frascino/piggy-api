-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "stopLossHitAt" TIMESTAMP(3),
ADD COLUMN     "stopLossSetAt" TIMESTAMP(3);

-- Existing stop losses have no known "set" date; only price action from now on
-- counts as a hit, so stale history cannot retroactively flag them.
UPDATE "positions" SET "stopLossSetAt" = NOW() WHERE "stopLossPrice" IS NOT NULL;
