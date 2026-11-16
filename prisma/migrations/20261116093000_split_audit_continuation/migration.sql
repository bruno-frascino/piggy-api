ALTER TABLE "account_split_actions"
ADD COLUMN "auditNumber" INTEGER,
ADD COLUMN "nextFingerprint" TEXT,
ADD COLUMN "previousFingerprint" TEXT;

CREATE UNIQUE INDEX "account_split_actions_accountId_auditNumber_key"
ON "account_split_actions"("accountId", "auditNumber");

ALTER TABLE "account_split_actions"
ADD CONSTRAINT "account_split_actions_audit_continuation_check" CHECK (
  ("auditNumber" IS NULL AND "previousFingerprint" IS NULL AND "nextFingerprint" IS NULL)
  OR (
    "auditNumber" IS NOT NULL AND "auditNumber" > 0
    AND "previousFingerprint" IS NOT NULL
    AND "nextFingerprint" IS NOT NULL
    AND "previousFingerprint" ~ '^[a-f0-9]{64}$'
    AND "nextFingerprint" ~ '^[a-f0-9]{64}$'
    AND "sourceFingerprint" = "previousFingerprint"
    AND "previousFingerprint" <> "nextFingerprint"
  )
);
