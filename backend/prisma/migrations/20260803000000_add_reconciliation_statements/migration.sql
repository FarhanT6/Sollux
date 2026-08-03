-- Reconciliation profiles: reusable mapping for a third party (e.g. a
-- property manager) who nets rent collection, a management fee, and
-- unrelated loan payments together in one monthly statement.
CREATE TABLE "reconciliation_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "propertyId" TEXT,
    "leaseId" TEXT,
    "managementFeeCategory" TEXT,
    "loanIds" JSONB NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_profiles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reconciliation_profiles_userId_idx" ON "reconciliation_profiles"("userId");

ALTER TABLE "reconciliation_profiles" ADD CONSTRAINT "reconciliation_profiles_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One month's actual statement against a profile's mapping.
CREATE TABLE "reconciliation_statements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "statementDate" TIMESTAMP(3) NOT NULL,
    "documentS3Key" TEXT,
    "documentUrl" TEXT,
    "lineItems" JSONB NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "appliedAt" TIMESTAMP(3),
    "createdRecordIds" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_statements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reconciliation_statements_userId_profileId_idx" ON "reconciliation_statements"("userId", "profileId");

ALTER TABLE "reconciliation_statements" ADD CONSTRAINT "reconciliation_statements_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "reconciliation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
